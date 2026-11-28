import mysql from "mysql2/promise";
import { isSafeHost } from "../config";
import { assertReadOnlySelect, ConnectorDocument, ConnectorPayload, safeFetch, sanitizeConnectorSourceName } from "./types";

export async function fetchMysqlConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const connStr = input.connectionString?.trim() || process.env.MYSQL_URL || "";
  if (!connStr) throw new Error("MySQL connection URL is required (UI or MYSQL_URL env)");

  const parsed = new URL(connStr);
  if (!["mysql:", "mysql2:"].includes(parsed.protocol)) {
    throw new Error("Invalid MySQL URL protocol");
  }
  if (!isSafeHost(parsed.hostname)) {
    throw new Error("MySQL host is blocked by network safety policy");
  }

  const maxRows = Math.min(500, input.maxRows || 100);
  const conn = await mysql.createConnection({
    uri: connStr,
    connectTimeout: 8000,
  });

  try {
    await conn.query("START TRANSACTION READ ONLY");
    const docs: ConnectorDocument[] = [];

    if (input.sqlQuery?.trim()) {
      const safeSql = assertReadOnlySelect(input.sqlQuery);
      const [rows, fields] = await conn.query(`SELECT * FROM (${safeSql}) AS _rag_sub LIMIT ?`, [maxRows]);
      const list = Array.isArray(rows) ? rows : [];
      const cols = Array.isArray(fields) ? fields.map((f: any) => f.name) : Object.keys(list[0] || {});
      const lines = list.map((r: any, i: number) => `Row ${i + 1}: ${cols.map(c => `${c}=${JSON.stringify(r[c])}`).join(" | ")}`);
      docs.push({
        sourceName: sanitizeConnectorSourceName(`mysql_query_${parsed.pathname.replace("/", "") || "db"}.txt`),
        content: `# MySQL Query Result\nColumns: ${cols.join(", ")}\n\n${lines.join("\n") || "(0 rows)"}`,
        metadata: { source: `mysql://${parsed.host}${parsed.pathname}`, section: "MySQL Query", page: 1 },
      });
    } else {
      let tables = input.tables || [];
      const dbName = parsed.pathname.replace(/^\//, "");
      if (tables.length === 0) {
        const [tblRows] = await conn.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_type = 'BASE TABLE' LIMIT 10",
          [dbName]
        );
        tables = (Array.isArray(tblRows) ? tblRows : []).map((r: any) => String(r.table_name || r.TABLE_NAME));
      }

      for (const tbl of tables.slice(0, 10)) {
        if (!/^[a-zA-Z0-9_]+$/.test(tbl)) continue;
        const [rows, fields] = await conn.query(`SELECT * FROM \`${tbl}\` LIMIT ?`, [maxRows]);
        const list = Array.isArray(rows) ? rows : [];
        const cols = Array.isArray(fields) ? fields.map((f: any) => f.name) : Object.keys(list[0] || {});
        const lines = list.map((r: any, i: number) => `Row ${i + 1}: ${cols.map(c => `${c}=${JSON.stringify(r[c])}`).join(" | ")}`);
        docs.push({
          sourceName: sanitizeConnectorSourceName(`mysql_${tbl}.txt`),
          content: `# MySQL Table ${tbl}\nColumns: ${cols.join(", ")}\n\n${lines.join("\n") || "(empty table)"}`,
          metadata: { source: `mysql://${parsed.host}/${dbName}/${tbl}`, section: tbl, page: 1 },
        });
      }
    }

    await conn.query("COMMIT");
    if (docs.length === 0) throw new Error("No MySQL tables or rows returned");
    return docs;
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await conn.end().catch(() => {});
  }
}

export async function fetchClickHouseConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.CLICKHOUSE_URL || "").replace(/\/+$/, "");
  const token = input.apiToken?.trim() || process.env.CLICKHOUSE_PASSWORD || "";
  const user = input.email?.trim() || process.env.CLICKHOUSE_USER || "default";
  if (!baseUrl) throw new Error("ClickHouse HTTP URL is required");

  const sql = assertReadOnlySelect(input.sqlQuery || "", "SELECT name, engine FROM system.tables LIMIT 25");
  const queryUrl = `${baseUrl}/?readonly=1&query=${encodeURIComponent(`${sql} FORMAT JSONEachRow`)}`;
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  }

  const res = await safeFetch(queryUrl, { headers });
  if (!res.ok) throw new Error(`ClickHouse HTTP failed (${res.status})`);
  const text = (await res.text()).trim();
  if (!text) throw new Error("ClickHouse query returned 0 rows");

  const lines = text.split(/\r?\n/).slice(0, input.maxRows || 200).map((line, i) => `Row ${i + 1}: ${line}`);
  return [{
    sourceName: sanitizeConnectorSourceName("clickhouse_query.txt"),
    content: `# ClickHouse Query Result\nSQL: ${sql}\n\n${lines.join("\n")}`,
    metadata: { source: baseUrl, section: "ClickHouse", page: 1 },
  }];
}

export async function fetchDatabricksConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.DATABRICKS_HOST || "").replace(/\/+$/, "");
  const token = input.apiToken?.trim() || process.env.DATABRICKS_TOKEN || "";
  const warehouseId = input.warehouseId?.trim() || process.env.DATABRICKS_WAREHOUSE_ID || "";
  if (!baseUrl || !token || !warehouseId) {
    throw new Error("Databricks Workspace URL, Token, and SQL Warehouse ID are required");
  }

  const sql = assertReadOnlySelect(input.sqlQuery || "", "SHOW TABLES");
  const res = await safeFetch(`${baseUrl}/api/2.0/sql/statements`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement: sql,
      wait_timeout: "15s",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    }),
  });
  if (!res.ok) throw new Error(`Databricks SQL API failed (${res.status})`);

  const data = await res.json();
  const cols: string[] = (data?.manifest?.schema?.columns || []).map((c: any) => c.name);
  const rows: any[][] = Array.isArray(data?.result?.data_array) ? data.result.data_array.slice(0, input.maxRows || 100) : [];
  if (rows.length === 0) throw new Error("Databricks SQL query returned 0 rows");

  const lines = rows.map((r, i) => `Row ${i + 1}: ${r.map((v, ci) => `${cols[ci] || ci}=${JSON.stringify(v)}`).join(" | ")}`);
  return [{
    sourceName: sanitizeConnectorSourceName("databricks_query.txt"),
    content: `# Databricks SQL Result\nColumns: ${cols.join(", ")}\n\n${lines.join("\n")}`,
    metadata: { source: baseUrl, section: "Databricks SQL", page: 1 },
  }];
}

export async function fetchTursoConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const rawUrl = (input.baseUrl?.trim() || process.env.TURSO_DATABASE_URL || "").replace(/^libsql:\/\//i, "https://").replace(/\/+$/, "");
  const token = input.apiToken?.trim() || process.env.TURSO_AUTH_TOKEN || "";
  if (!rawUrl || !token) throw new Error("Turso Database URL and Auth Token are required");

  const sql = assertReadOnlySelect(input.sqlQuery || "", "SELECT name, type FROM sqlite_master WHERE type='table' LIMIT 25");
  const res = await safeFetch(`${rawUrl}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql } },
        { type: "close" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Turso HTTP API failed (${res.status})`);

  const data = await res.json();
  const execResult = data?.results?.[0]?.response?.result;
  const cols: string[] = (execResult?.cols || []).map((c: any) => c.name);
  const rows: any[][] = Array.isArray(execResult?.rows) ? execResult.rows.slice(0, input.maxRows || 100) : [];
  if (rows.length === 0) throw new Error("Turso query returned 0 rows");

  const lines = rows.map((row, i) => {
    const vals = row.map((cell: any, ci: number) => `${cols[ci] || ci}=${JSON.stringify(cell?.value ?? null)}`);
    return `Row ${i + 1}: ${vals.join(" | ")}`;
  });

  return [{
    sourceName: sanitizeConnectorSourceName("turso_query.txt"),
    content: `# Turso / LibSQL Query Result\nColumns: ${cols.join(", ")}\n\n${lines.join("\n")}`,
    metadata: { source: rawUrl, section: "Turso SQL", page: 1 },
  }];
}
