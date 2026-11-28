import { Client } from "pg";
import { isSafeHost } from "../config";
import { ConnectorDocument, ConnectorPayload, sanitizeConnectorSourceName } from "./types";

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|call|do)\b/i;

function validateReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;+$/, "");
  if (!trimmed) throw new Error("SQL query cannot be empty");
  if (trimmed.includes(";")) throw new Error("Multiple SQL statements are prohibited");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT queries are permitted");
  }
  if (FORBIDDEN_SQL.test(trimmed)) {
    throw new Error("Disallowed SQL keyword detected in query");
  }
  return trimmed;
}

export async function fetchPostgresConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const connStr = input.connectionString?.trim() || process.env.POSTGRES_URL || "";
  if (!connStr) throw new Error("PostgreSQL connection string is required (UI or POSTGRES_URL env)");

  const parsed = new URL(connStr);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Invalid PostgreSQL URL protocol");
  }
  if (!isSafeHost(parsed.hostname)) {
    throw new Error("PostgreSQL host is blocked by network safety policy");
  }

  const maxRows = Math.min(500, input.maxRows || 100);
  const client = new Client({
    connectionString: connStr,
    connectionTimeoutMillis: 8000,
    query_timeout: 10000,
  });

  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10000'");

    const docs: ConnectorDocument[] = [];

    if (input.sqlQuery?.trim()) {
      const safeSql = validateReadOnlySql(input.sqlQuery);
      const res = await client.query(`SELECT * FROM (${safeSql}) AS _rag_sub LIMIT $1`, [maxRows]);
      const cols = res.fields.map(f => f.name);
      const rows = res.rows.map((r, i) => `Row ${i + 1}: ${cols.map(c => `${c}=${JSON.stringify(r[c])}`).join(" | ")}`);
      docs.push({
        sourceName: sanitizeConnectorSourceName(`postgres_query_${parsed.pathname.replace("/", "") || "db"}.txt`),
        content: `# PostgreSQL Query Result\nColumns: ${cols.join(", ")}\n\n${rows.join("\n")}`,
        metadata: { source: `postgres://${parsed.host}${parsed.pathname}`, section: "SQL Query", page: 1 },
      });
    } else {
      let tables = input.tables || [];
      if (tables.length === 0) {
        const tblRes = await client.query(
          "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' LIMIT 10"
        );
        tables = tblRes.rows.map((r: any) => `${r.table_schema}.${r.table_name}`);
      }

      for (const tbl of tables.slice(0, 10)) {
        const parts = tbl.split(".");
        const schema = parts.length === 2 ? parts[0] : "public";
        const table = parts.length === 2 ? parts[1] : parts[0];
        if (!/^[a-zA-Z0-9_]+$/.test(schema) || !/^[a-zA-Z0-9_]+$/.test(table)) continue;

        const safeIdent = `"${schema}"."${table}"`;
        const res = await client.query(`SELECT * FROM ${safeIdent} LIMIT $1`, [maxRows]);
        const cols = res.fields.map(f => f.name);
        const rows = res.rows.map((r, i) => `Row ${i + 1}: ${cols.map(c => `${c}=${JSON.stringify(r[c])}`).join(" | ")}`);
        docs.push({
          sourceName: sanitizeConnectorSourceName(`postgres_${schema}_${table}.txt`),
          content: `# Table ${schema}.${table}\nColumns: ${cols.join(", ")}\n\n${rows.join("\n") || "(empty table)"}`,
          metadata: { source: `postgres://${parsed.host}/${schema}.${table}`, section: `${schema}.${table}`, page: 1 },
        });
      }
    }

    await client.query("COMMIT");
    if (docs.length === 0) throw new Error("No PostgreSQL tables or rows returned");
    return docs;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}
