import { ConnectorDocument, ConnectorPayload, htmlToText, safeFetch, sanitizeConnectorSourceName } from "./types";

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|call)\b/i;

function assertReadOnlySelect(sql: string, defaultSql: string): string {
  const raw = (sql || defaultSql).trim().replace(/;+$/, "");
  if (!raw || raw.includes(";") || !/^(select|with)\b/i.test(raw) || FORBIDDEN_SQL.test(raw)) {
    throw new Error("Only single read-only SELECT queries are permitted");
  }
  return raw;
}

export async function fetchSalesforceConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.SALESFORCE_INSTANCE_URL || "").replace(/\/+$/, "");
  const token = input.apiToken?.trim() || process.env.SALESFORCE_ACCESS_TOKEN || "";
  if (!baseUrl || !token) throw new Error("Salesforce Instance URL and Access Token are required");

  const soql = assertReadOnlySelect(input.sqlQuery || "", "SELECT Id, Name, Industry, Description FROM Account LIMIT 25");
  const res = await safeFetch(
    `${baseUrl}/services/data/v61.0/query/?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Salesforce SOQL failed (${res.status})`);
  const data = await res.json();
  const records = Array.isArray(data?.records) ? data.records : [];
  if (records.length === 0) throw new Error("Salesforce query returned 0 records");

  const lines = records.map((rec: any, i: number) => {
    const clean = { ...rec };
    delete clean.attributes;
    return `Record ${i + 1}: ${JSON.stringify(clean)}`;
  });

  return [{
    sourceName: sanitizeConnectorSourceName("salesforce_records.txt"),
    content: `# Salesforce SOQL Result\nQuery: ${soql}\n\n${lines.join("\n")}`,
    metadata: { source: baseUrl, section: "Salesforce CRM", page: 1 },
  }];
}

export async function fetchZendeskConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.ZENDESK_BASE_URL || "").replace(/\/+$/, "");
  const email = input.email?.trim() || process.env.ZENDESK_EMAIL || "";
  const token = input.apiToken?.trim() || process.env.ZENDESK_API_TOKEN || "";
  if (!baseUrl || !token) throw new Error("Zendesk Base URL and API Token are required");

  const authHeader = email
    ? `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`
    : `Bearer ${token}`;
  const headers = { Authorization: authHeader, Accept: "application/json" };

  const docs: ConnectorDocument[] = [];
  const artRes = await safeFetch(`${baseUrl}/api/v2/help_center/articles.json?per_page=20`, { headers });
  if (artRes.ok) {
    const artData = await artRes.json();
    for (const art of artData?.articles || []) {
      const text = htmlToText(art.body || "");
      if (!text) continue;
      docs.push({
        sourceName: sanitizeConnectorSourceName(`zendesk_article_${art.title || art.id}.md`),
        content: `# ${art.title}\n\n${text}`,
        metadata: { source: art.html_url || baseUrl, section: String(art.title || "").slice(0, 80), page: 1 },
      });
    }
  }

  const tickRes = await safeFetch(`${baseUrl}/api/v2/tickets.json?per_page=20`, { headers });
  if (tickRes.ok) {
    const tickData = await tickRes.json();
    for (const t of tickData?.tickets || []) {
      docs.push({
        sourceName: sanitizeConnectorSourceName(`zendesk_ticket_${t.id}.md`),
        content: `# Ticket #${t.id}: ${t.subject || ""}\nStatus: ${t.status} | Priority: ${t.priority || "normal"}\n\n${t.description || ""}`,
        metadata: { source: `${baseUrl}/agent/tickets/${t.id}`, section: `Ticket #${t.id}`, page: 1 },
      });
    }
  }

  if (docs.length === 0) throw new Error("No Zendesk articles or tickets retrieved");
  return docs;
}

export async function fetchHubSpotConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.HUBSPOT_ACCESS_TOKEN || "";
  if (!token) throw new Error("HubSpot Private App Access Token is required");

  const obj = (input.query?.trim() || "deals").toLowerCase();
  const allowedObjects = new Set(["contacts", "companies", "deals", "tickets"]);
  const target = allowedObjects.has(obj) ? obj : "deals";

  const res = await safeFetch(
    `https://api.hubapi.com/crm/v3/objects/${target}?limit=25`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`HubSpot API failed (${res.status})`);
  const data = await res.json();
  const items = Array.isArray(data?.results) ? data.results : [];
  if (items.length === 0) throw new Error(`No HubSpot ${target} found`);

  const content = items
    .map((it: any) => `## ${target.slice(0, -1)} ${it.id}\n${JSON.stringify(it.properties || {})}`)
    .join("\n\n");

  return [{
    sourceName: sanitizeConnectorSourceName(`hubspot_${target}.txt`),
    content: `# HubSpot ${target}\n\n${content}`,
    metadata: { source: `hubspot://${target}`, section: `HubSpot ${target}`, page: 1 },
  }];
}

export async function fetchSnowflakeConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.SNOWFLAKE_ACCOUNT_URL || "").replace(/\/+$/, "");
  const token = input.apiToken?.trim() || process.env.SNOWFLAKE_TOKEN || "";
  if (!baseUrl || !token) throw new Error("Snowflake Account URL and Bearer Token are required");

  const sql = assertReadOnlySelect(input.sqlQuery || "", "SELECT CURRENT_VERSION() AS version");
  const res = await safeFetch(`${baseUrl}/api/v2/statements`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ statement: sql, timeout: 15 }),
  });
  if (!res.ok) throw new Error(`Snowflake SQL API failed (${res.status})`);
  const data = await res.json();
  const cols: string[] = (data?.resultSetMetaData?.rowType || []).map((c: any) => c.name);
  const rows: any[][] = Array.isArray(data?.data) ? data.data.slice(0, input.maxRows || 100) : [];
  if (rows.length === 0) throw new Error("Snowflake query returned 0 rows");

  const lines = rows.map((r, i) => `Row ${i + 1}: ${r.map((v, ci) => `${cols[ci] || ci}=${JSON.stringify(v)}`).join(" | ")}`);
  return [{
    sourceName: sanitizeConnectorSourceName("snowflake_query.txt"),
    content: `# Snowflake Query Result\nColumns: ${cols.join(", ")}\n\n${lines.join("\n")}`,
    metadata: { source: baseUrl, section: "Snowflake", page: 1 },
  }];
}

export async function fetchMongoDbConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const endpoint = (input.baseUrl?.trim() || process.env.MONGODB_DATA_API_URL || "").replace(/\/+$/, "");
  const apiKey = input.apiToken?.trim() || process.env.MONGODB_DATA_API_KEY || "";
  const database = input.projectId?.trim() || "test";
  const collection = input.query?.trim() || "documents";
  if (!endpoint || !apiKey) throw new Error("MongoDB Atlas Data API URL and API Key are required");

  const res = await safeFetch(`${endpoint}/action/find`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      dataSource: input.teamId?.trim() || "Cluster0",
      database,
      collection,
      limit: Math.min(200, input.maxRows || 50),
    }),
  });
  if (!res.ok) throw new Error(`MongoDB Data API failed (${res.status})`);
  const data = await res.json();
  const docsList = Array.isArray(data?.documents) ? data.documents : [];
  if (docsList.length === 0) throw new Error("MongoDB collection returned 0 documents");

  return [{
    sourceName: sanitizeConnectorSourceName(`mongodb_${database}_${collection}.json`),
    content: `# MongoDB ${database}.${collection}\n\n${docsList.map((d: any) => JSON.stringify(d)).join("\n")}`,
    metadata: { source: `mongodb://${database}/${collection}`, section: `${database}.${collection}`, page: 1 },
  }];
}
