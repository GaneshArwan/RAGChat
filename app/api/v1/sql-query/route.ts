import { NextResponse } from "next/server";
import { z } from "zod";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import { generateText } from "ai";
import { ConfigSchema, isSafeHost } from "@/lib/config";
import { getModelProvider } from "@/lib/models";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, sanitizeLog } from "@/lib/validation";
import { assertReadOnlySelect } from "@/lib/connectors/types";
import { redactPii, recordAuditEvent, verifyBearerToken } from "@/lib/security";
import { resolveAuthContext } from "@/lib/auth";

const SqlQuerySchema = z.object({
  question: z.string().min(3).max(2000),
  dbType: z.enum(["postgres", "mysql"]),
  connectionString: z.string().max(1000).optional(),
  maxRows: z.number().int().min(1).max(200).default(50),
  config: ConfigSchema,
});

function extractCleanSql(rawText: string): string {
  const fenced = rawText.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : rawText).trim();
  // Strip trailing semicolon for subquery wrapping
  return candidate.replace(/;+\s*$/, "").trim();
}

async function introspectAndRunPostgres(
  connStr: string,
  maxRows: number,
  buildSql: (schemaSummary: string) => Promise<string>
): Promise<{ sql: string; rows: any[]; schemaTables: string[] }> {
  const client = new PgClient({ connectionString: connStr, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const schemaRes = await client.query(
      `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position
       LIMIT 150`
    );

    const byTable = new Map<string, string[]>();
    for (const r of schemaRes.rows || []) {
      const tbl = `${r.table_schema}.${r.table_name}`;
      if (!byTable.has(tbl)) byTable.set(tbl, []);
      byTable.get(tbl)!.push(`${r.column_name} (${r.data_type})`);
    }
    if (byTable.size === 0) {
      throw new Error("No user tables found in PostgreSQL database");
    }

    const schemaSummary = Array.from(byTable.entries())
      .map(([tbl, cols]) => `- ${tbl}: ${cols.join(", ")}`)
      .join("\n");

    const generatedSql = await buildSql(schemaSummary);
    const safeSql = assertReadOnlySelect(generatedSql);
    const res = await client.query(`SELECT * FROM (${safeSql}) AS _rag_sql LIMIT $1`, [maxRows]);
    await client.query("COMMIT");

    return {
      sql: safeSql,
      rows: res.rows || [],
      schemaTables: Array.from(byTable.keys()),
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

async function introspectAndRunMysql(
  connStr: string,
  dbName: string,
  maxRows: number,
  buildSql: (schemaSummary: string) => Promise<string>
): Promise<{ sql: string; rows: any[]; schemaTables: string[] }> {
  const conn = await mysql.createConnection({ uri: connStr, connectTimeout: 8000 });
  try {
    await conn.query("START TRANSACTION READ ONLY");
    const [colRows] = await conn.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE())
       ORDER BY table_name, ordinal_position
       LIMIT 150`,
      [dbName]
    );

    const byTable = new Map<string, string[]>();
    for (const r of Array.isArray(colRows) ? (colRows as any[]) : []) {
      const tbl = String(r.table_name || r.TABLE_NAME || "");
      const col = String(r.column_name || r.COLUMN_NAME || "");
      const dt = String(r.data_type || r.DATA_TYPE || "");
      if (!tbl || !col) continue;
      if (!byTable.has(tbl)) byTable.set(tbl, []);
      byTable.get(tbl)!.push(`${col} (${dt})`);
    }
    if (byTable.size === 0) {
      throw new Error("No user tables found in MySQL database");
    }

    const schemaSummary = Array.from(byTable.entries())
      .map(([tbl, cols]) => `- ${tbl}: ${cols.join(", ")}`)
      .join("\n");

    const generatedSql = await buildSql(schemaSummary);
    const safeSql = assertReadOnlySelect(generatedSql);
    const [rows] = await conn.query(`SELECT * FROM (${safeSql}) AS _rag_sql LIMIT ?`, [maxRows]);
    await conn.query("COMMIT");

    return {
      sql: safeSql,
      rows: Array.isArray(rows) ? rows : [],
      schemaTables: Array.from(byTable.keys()),
    };
  } catch (err) {
    try {
      await conn.query("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  } finally {
    await conn.end().catch(() => {});
  }
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  try {
    if (!verifyBearerToken(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
    }

    const parsed = SqlQuerySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid SQL query request", details: parsed.error.format() }, { status: 400 });
    }

    const { question, dbType, connectionString, maxRows, config } = parsed.data;
    const auth = resolveAuthContext(req, config.tenantId, config.userRoles);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized: invalid JWT" }, { status: 401 });
    }

    if (!await rateLimit(ip, config, 20, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const connStr =
      connectionString?.trim() ||
      (dbType === "postgres" ? process.env.POSTGRES_URL : process.env.MYSQL_URL) ||
      "";
    if (!connStr) {
      return NextResponse.json(
        { error: `${dbType} connectionString or environment fallback is required` },
        { status: 400 }
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(connStr);
    } catch {
      return NextResponse.json({ error: "Malformed database connection URL" }, { status: 400 });
    }

    const validProto =
      dbType === "postgres"
        ? ["postgres:", "postgresql:"].includes(parsedUrl.protocol)
        : ["mysql:", "mysql2:"].includes(parsedUrl.protocol);
    if (!validProto) {
      return NextResponse.json({ error: `Invalid ${dbType} URL protocol` }, { status: 400 });
    }
    if (!isSafeHost(parsedUrl.hostname)) {
      return NextResponse.json({ error: "Database host blocked by network safety policy" }, { status: 403 });
    }

    const model = getModelProvider(config);
    const buildSql = async (schemaSummary: string) => {
      const dialect = dbType === "postgres" ? "PostgreSQL" : "MySQL";
      const { text } = await generateText({
        model,
        temperature: 0,
        maxOutputTokens: 300,
        abortSignal: AbortSignal.timeout(20000),
        system:
          `You are a ${dialect} query generator.\n` +
          `Generate ONE single read-only SELECT or WITH query matching the schema below.\n` +
          `Rules:\n` +
          `- Only use tables and columns present in the schema.\n` +
          `- Never emit DDL/DML (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, COPY).\n` +
          `- Return ONLY the SQL statement with no explanation.\n\n` +
          `SCHEMA:\n${schemaSummary}`,
        prompt: question,
      });
      return extractCleanSql(text);
    };

    const result =
      dbType === "postgres"
        ? await introspectAndRunPostgres(connStr, maxRows, buildSql)
        : await introspectAndRunMysql(
            connStr,
            parsedUrl.pathname.replace(/^\//, ""),
            maxRows,
            buildSql
          );

    const rawRowsJson = JSON.stringify(result.rows, null, 2);
    const safeRowsText = config.enablePiiRedaction ? redactPii(rawRowsJson).text : rawRowsJson;

    const { text: answer } = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 600,
      abortSignal: AbortSignal.timeout(20000),
      system:
        `Summarize the SQL query results concisely and accurately using ONLY the returned rows below.`,
      prompt: `Question: ${question}\nExecuted SQL: ${result.sql}\nRows (${result.rows.length}):\n${safeRowsText.slice(0, 12000)}`,
    });

    if (config.enableAuditLog !== false) {
      recordAuditEvent({
        action: "query",
        tenantId: auth.tenantId,
        roles: auth.roles,
        actorIp: ip,
        provider: config.provider,
        details: {
          endpoint: "/api/v1/sql-query",
          dbType,
          rowCount: result.rows.length,
        },
        status: "success",
      });
    }

    return NextResponse.json({
      question,
      dbType,
      sql: result.sql,
      rowCount: result.rows.length,
      rows: JSON.parse(safeRowsText),
      schemaTables: result.schemaTables,
      answer,
    });
  } catch (error: any) {
    console.error("[SQL Query] Error:", sanitizeLog(error?.message || "Unknown error"));
    return NextResponse.json({ error: sanitizeLog(error?.message || "SQL query failed") }, { status: 400 });
  }
}
