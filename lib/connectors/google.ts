import { ConnectorDocument, ConnectorPayload, parseCsv, safeFetch, sanitizeConnectorSourceName } from "./types";

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|call)\b/i;

function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;+$/, "");
  if (!trimmed || trimmed.includes(";") || !/^(select|with)\b/i.test(trimmed) || FORBIDDEN_SQL.test(trimmed)) {
    throw new Error("Only single read-only SELECT queries are permitted");
  }
  return trimmed;
}

export async function fetchGmailConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.GMAIL_ACCESS_TOKEN || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "";
  if (!token) throw new Error("Gmail OAuth Access Token is required");

  const headers = { Authorization: `Bearer ${token}` };
  const q = encodeURIComponent(input.query?.trim() || "in:inbox");
  const listRes = await safeFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=15`,
    { headers }
  );
  if (!listRes.ok) throw new Error(`Gmail API failed (${listRes.status})`);

  const listData = await listRes.json();
  const messages = Array.isArray(listData?.messages) ? listData.messages : [];
  const docs: ConnectorDocument[] = [];

  for (const m of messages) {
    const msgRes = await safeFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=full`,
      { headers }
    );
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    const hdrs: Array<{ name: string; value: string }> = msg?.payload?.headers || [];
    const subject = hdrs.find(h => h.name === "Subject")?.value || "(No Subject)";
    const from = hdrs.find(h => h.name === "From")?.value || "Unknown";
    const date = hdrs.find(h => h.name === "Date")?.value || "";

    let bodyText = msg?.snippet || "";
    const parts = msg?.payload?.parts || [];
    const plainPart = parts.find((p: any) => p.mimeType === "text/plain" && p.body?.data) || (msg?.payload?.body?.data ? msg.payload : null);
    if (plainPart?.body?.data) {
      bodyText = Buffer.from(plainPart.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }

    docs.push({
      sourceName: sanitizeConnectorSourceName(`gmail_${subject}_${m.id.slice(0, 6)}.txt`),
      content: `# ${subject}\nFrom: ${from}\nDate: ${date}\n\n${bodyText.slice(0, 30000)}`,
      metadata: { source: `gmail://${m.id}`, section: subject.slice(0, 80), page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No Gmail messages matched query");
  return docs;
}

export async function fetchGoogleSheetsConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.GOOGLE_SHEETS_ACCESS_TOKEN || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "";
  const spreadsheetId = input.projectId?.trim() || input.folderId?.trim();
  const range = input.query?.trim() || "A1:Z200";
  if (!token || !spreadsheetId) throw new Error("Google Sheets OAuth Token and Spreadsheet ID are required");

  const res = await safeFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Google Sheets API failed (${res.status})`);
  const data = await res.json();
  const values: any[][] = Array.isArray(data?.values) ? data.values : [];
  if (values.length === 0) throw new Error("Spreadsheet range returned no rows");

  const csv = values.map(row => row.map(cell => `"${String(cell ?? "").replace(/"/g, "\"\"")}"`).join(",")).join("\n");
  return [{
    sourceName: sanitizeConnectorSourceName(`gsheet_${spreadsheetId}.csv`),
    content: `# Google Sheet ${spreadsheetId} (${range})\n\n${parseCsv(csv)}`,
    metadata: { source: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`, section: range, page: 1 },
  }];
}

export async function fetchBigQueryConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.BIGQUERY_ACCESS_TOKEN || "";
  const projectId = input.projectId?.trim() || process.env.GOOGLE_CLOUD_PROJECT || "";
  const sql = assertReadOnlySql(input.sqlQuery || "");
  if (!token || !projectId) throw new Error("BigQuery OAuth Token, GCP Project ID, and SELECT SQL are required");

  const res = await safeFetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        maxResults: Math.min(500, input.maxRows || 100),
      }),
    }
  );
  if (!res.ok) throw new Error(`BigQuery API failed (${res.status})`);

  const data = await res.json();
  const fields: string[] = (data?.schema?.fields || []).map((f: any) => f.name);
  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  if (rows.length === 0) throw new Error("BigQuery query returned 0 rows");

  const formatted = rows.map((row: any, idx: number) => {
    const cells = (row.f || []).map((cell: any, i: number) => `${fields[i] || `col_${i}`}=${JSON.stringify(cell?.v)}`);
    return `Row ${idx + 1}: ${cells.join(" | ")}`;
  });

  return [{
    sourceName: sanitizeConnectorSourceName(`bigquery_${projectId}.txt`),
    content: `# BigQuery (${projectId})\nColumns: ${fields.join(", ")}\n\n${formatted.join("\n")}`,
    metadata: { source: `bigquery://${projectId}`, section: "BigQuery Result", page: 1 },
  }];
}

export async function fetchGcsConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.GCS_ACCESS_TOKEN || "";
  const bucket = input.bucket?.trim();
  if (!token || !bucket) throw new Error("GCS OAuth Token and Bucket name are required");

  const headers = { Authorization: `Bearer ${token}` };
  const prefix = input.prefix?.trim() ? `&prefix=${encodeURIComponent(input.prefix.trim())}` : "";
  const listRes = await safeFetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?maxResults=20${prefix}`,
    { headers }
  );
  if (!listRes.ok) throw new Error(`GCS list failed (${listRes.status})`);

  const data = await listRes.json();
  const items = (Array.isArray(data?.items) ? data.items : [])
    .filter((it: any) => /\.(txt|md|csv|json|ts|py|sql|log)$/i.test(it?.name || ""))
    .slice(0, 15);

  const docs: ConnectorDocument[] = [];
  for (const it of items) {
    const objRes = await safeFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(it.name)}?alt=media`,
      { headers }
    );
    if (!objRes.ok) continue;
    const raw = await objRes.text();
    const content = it.name.toLowerCase().endsWith(".csv") ? parseCsv(raw) : raw;
    if (!content.trim()) continue;
    docs.push({
      sourceName: sanitizeConnectorSourceName(`gcs_${bucket}_${it.name}`),
      content: `# gs://${bucket}/${it.name}\n\n${content.slice(0, 60000)}`,
      metadata: { source: `gs://${bucket}/${it.name}`, section: it.name, page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No readable text objects found in GCS bucket");
  return docs;
}
