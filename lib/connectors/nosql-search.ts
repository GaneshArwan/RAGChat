import crypto from "crypto";
import Redis from "ioredis";
import { isSafeHost } from "../config";
import { ConnectorDocument, ConnectorPayload, safeFetch, sanitizeConnectorSourceName } from "./types";

export function unwrapFirestoreValue(val: any): any {
  if (!val || typeof val !== "object") return val;
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return Number(val.doubleValue);
  if ("booleanValue" in val) return Boolean(val.booleanValue);
  if ("nullValue" in val) return null;
  if ("timestampValue" in val) return val.timestampValue;
  if ("arrayValue" in val) return (val.arrayValue?.values || []).map(unwrapFirestoreValue);
  if ("mapValue" in val) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val.mapValue?.fields || {})) {
      out[k] = unwrapFirestoreValue(v);
    }
    return out;
  }
  return val;
}

export function unwrapDynamoValue(val: any): any {
  if (!val || typeof val !== "object") return val;
  if ("S" in val) return val.S;
  if ("N" in val) return Number(val.N);
  if ("BOOL" in val) return Boolean(val.BOOL);
  if ("NULL" in val) return null;
  if ("SS" in val) return val.SS;
  if ("NS" in val) return (val.NS || []).map(Number);
  if ("L" in val) return (val.L || []).map(unwrapDynamoValue);
  if ("M" in val) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val.M || {})) {
      out[k] = unwrapDynamoValue(v);
    }
    return out;
  }
  return val;
}

export async function fetchSupabaseConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const apiKey = input.apiToken?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  const tableName = input.tableName?.trim() || input.query?.trim();
  if (!baseUrl || !apiKey || !tableName || !/^[a-zA-Z0-9_]+$/.test(tableName)) {
    throw new Error("Supabase URL, API Key, and valid Table Name are required");
  }

  const limit = Math.min(500, input.maxRows || 100);
  const res = await safeFetch(`${baseUrl}/rest/v1/${encodeURIComponent(tableName)}?select=*&limit=${limit}`, {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase REST failed (${res.status})`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`No rows returned from Supabase table "${tableName}"`);

  const lines = rows.map((r, i) => `Row ${i + 1}: ${JSON.stringify(r)}`);
  return [{
    sourceName: sanitizeConnectorSourceName(`supabase_${tableName}.txt`),
    content: `# Supabase Table: ${tableName}\n\n${lines.join("\n")}`,
    metadata: { source: `${baseUrl}/rest/v1/${tableName}`, section: tableName, page: 1 },
  }];
}

export async function fetchElasticsearchConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.ELASTICSEARCH_URL || "").replace(/\/+$/, "");
  const indexName = input.indexName?.trim() || input.query?.trim() || "_all";
  const token = input.apiToken?.trim() || process.env.ELASTICSEARCH_API_KEY || "";
  const email = input.email?.trim() || "";
  if (!baseUrl) throw new Error("Elasticsearch / OpenSearch URL is required");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = email
      ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
      : `ApiKey ${token}`;
  }

  const bodyPayload = input.sqlQuery?.trim()
    ? { size: Math.min(100, input.maxRows || 25), query: { query_string: { query: input.sqlQuery.trim() } } }
    : { size: Math.min(100, input.maxRows || 25), query: { match_all: {} } };

  const res = await safeFetch(`${baseUrl}/${encodeURIComponent(indexName)}/_search`, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyPayload),
  });
  if (!res.ok) throw new Error(`Elasticsearch search failed (${res.status})`);
  const data = await res.json();
  const hits = data?.hits?.hits || [];
  if (hits.length === 0) throw new Error("Elasticsearch index returned 0 hits");

  const lines = hits.map((h: any, i: number) => `Doc ${i + 1} (${h._id}): ${JSON.stringify(h._source || {})}`);
  return [{
    sourceName: sanitizeConnectorSourceName(`elastic_${indexName}.txt`),
    content: `# Elasticsearch Index: ${indexName}\n\n${lines.join("\n")}`,
    metadata: { source: `${baseUrl}/${indexName}`, section: indexName, page: 1 },
  }];
}

export async function fetchFirestoreConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const projectId = input.projectId?.trim() || process.env.FIREBASE_PROJECT_ID || "";
  const collection = input.tableName?.trim() || input.query?.trim() || "";
  const token = input.apiToken?.trim() || process.env.FIRESTORE_ACCESS_TOKEN || "";
  if (!projectId || !collection || !token) {
    throw new Error("Firebase Project ID, Collection name, and OAuth Access Token are required");
  }

  const pageSize = Math.min(200, input.maxRows || 50);
  const res = await safeFetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodeURIComponent(collection)}?pageSize=${pageSize}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Firestore REST API failed (${res.status})`);
  const data = await res.json();
  const docs = Array.isArray(data?.documents) ? data.documents : [];
  if (docs.length === 0) throw new Error("Firestore collection returned 0 documents");

  const lines = docs.map((d: any, i: number) => {
    const unpacked: Record<string, any> = {};
    for (const [k, v] of Object.entries(d.fields || {})) {
      unpacked[k] = unwrapFirestoreValue(v);
    }
    const id = String(d.name || "").split("/").pop();
    return `Doc ${i + 1} (${id}): ${JSON.stringify(unpacked)}`;
  });

  return [{
    sourceName: sanitizeConnectorSourceName(`firestore_${projectId}_${collection}.json`),
    content: `# Firestore ${projectId}/${collection}\n\n${lines.join("\n")}`,
    metadata: { source: `firestore://${projectId}/${collection}`, section: collection, page: 1 },
  }];
}

export async function fetchDynamoDbConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const tableName = input.tableName?.trim();
  const region = input.region?.trim() || process.env.AWS_REGION || "us-east-1";
  const accessKeyId = input.accessKeyId?.trim() || process.env.AWS_ACCESS_KEY_ID || "";
  const secretAccessKey = input.secretAccessKey?.trim() || process.env.AWS_SECRET_ACCESS_KEY || "";
  const endpointBase = (input.endpoint?.trim() || `https://dynamodb.${region}.amazonaws.com`).replace(/\/+$/, "");

  if (!tableName || !accessKeyId || !secretAccessKey) {
    throw new Error("DynamoDB Table Name, Access Key ID, and Secret Access Key are required");
  }

  const body = JSON.stringify({ TableName: tableName, Limit: Math.min(100, input.maxRows || 50) });
  const parsed = new URL(endpointBase);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  const hmac = (k: crypto.BinaryLike, s: string) => crypto.createHmac("sha256", k).update(s, "utf8").digest();

  const payloadHash = sha256(body);
  const amzTarget = "DynamoDB_20120810.Scan";
  const canonicalHeaders = `content-type:application/x-amz-json-1.0\nhost:${parsed.host}\nx-amz-date:${amzDate}\nx-amz-target:${amzTarget}\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-target";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/dynamodb/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "dynamodb");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const res = await safeFetch(`${endpointBase}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Date": amzDate,
      "X-Amz-Target": amzTarget,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`DynamoDB Scan failed (${res.status})`);
  const data = await res.json();
  const items = Array.isArray(data?.Items) ? data.Items : [];
  if (items.length === 0) throw new Error("DynamoDB table returned 0 items");

  const lines = items.map((item: any, i: number) => {
    const flat: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) {
      flat[k] = unwrapDynamoValue(v);
    }
    return `Item ${i + 1}: ${JSON.stringify(flat)}`;
  });

  return [{
    sourceName: sanitizeConnectorSourceName(`dynamodb_${tableName}.json`),
    content: `# DynamoDB Table: ${tableName}\n\n${lines.join("\n")}`,
    metadata: { source: `dynamodb://${region}/${tableName}`, section: tableName, page: 1 },
  }];
}

export async function fetchAirtableConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.AIRTABLE_API_TOKEN || "";
  const baseId = input.projectId?.trim() || "";
  const tableName = input.tableName?.trim() || input.query?.trim() || "";
  if (!token || !baseId || !tableName) {
    throw new Error("Airtable API Token, Base ID, and Table Name are required");
  }

  const maxRecords = Math.min(100, input.maxRows || 50);
  const res = await safeFetch(
    `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}?maxRecords=${maxRecords}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Airtable API failed (${res.status})`);
  const data = await res.json();
  const records = Array.isArray(data?.records) ? data.records : [];
  if (records.length === 0) throw new Error("Airtable table returned 0 records");

  const lines = records.map((r: any, i: number) => `Record ${i + 1} (${r.id}): ${JSON.stringify(r.fields || {})}`);
  return [{
    sourceName: sanitizeConnectorSourceName(`airtable_${baseId}_${tableName}.txt`),
    content: `# Airtable ${baseId}/${tableName}\n\n${lines.join("\n")}`,
    metadata: { source: `https://airtable.com/${baseId}`, section: tableName, page: 1 },
  }];
}

export async function fetchRedisDbConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const connStr = input.connectionString?.trim() || process.env.REDIS_DATA_URL || "";
  if (!connStr) throw new Error("Redis connection URL is required");

  const parsed = new URL(connStr);
  if (!["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new Error("Invalid Redis URL protocol");
  }
  if (!isSafeHost(parsed.hostname)) {
    throw new Error("Redis host is blocked by network safety policy");
  }

  const pattern = input.keyPattern?.trim() || "*";
  const maxKeys = Math.min(100, input.maxRows || 50);
  const client = new Redis(connStr, {
    maxRetriesPerRequest: 1,
    connectTimeout: 4000,
    retryStrategy: () => null,
  });
  client.on("error", () => {});

  try {
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [nextCursor, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 50);
      cursor = nextCursor;
      for (const k of batch) {
        keys.push(k);
        if (keys.length >= maxKeys) break;
      }
    } while (cursor !== "0" && keys.length < maxKeys);

    if (keys.length === 0) throw new Error(`No Redis keys matched pattern "${pattern}"`);

    const lines: string[] = [];
    for (const key of keys) {
      const type = await client.type(key);
      if (type === "string") {
        const val = await client.get(key);
        lines.push(`${key} (string): ${val}`);
      } else if (type === "hash") {
        const val = await client.hgetall(key);
        lines.push(`${key} (hash): ${JSON.stringify(val)}`);
      } else if (type === "list") {
        const val = await client.lrange(key, 0, 20);
        lines.push(`${key} (list): ${JSON.stringify(val)}`);
      } else if (type === "set") {
        const val = await client.smembers(key);
        lines.push(`${key} (set): ${JSON.stringify(val.slice(0, 20))}`);
      }
    }

    return [{
      sourceName: sanitizeConnectorSourceName(`redis_${parsed.hostname}_${pattern.replace(/\*/g, "all")}.txt`),
      content: `# Redis Snapshot (${pattern})\n\n${lines.join("\n")}`,
      metadata: { source: `redis://${parsed.hostname}`, section: `Redis ${pattern}`, page: 1 },
    }];
  } finally {
    client.disconnect();
  }
}
