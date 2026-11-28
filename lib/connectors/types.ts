import { z } from "zod";
import { validateSafeUrl } from "../config";

export const CONNECTOR_TYPES = [
  "web",
  "github",
  "notion",
  "confluence",
  "jira",
  "asana",
  "linear",
  "slack",
  "s3",
  "gdrive",
  "sharepoint",
  "postgres",
  "gmail",
  "gsheets",
  "bigquery",
  "gcs",
  "msteams",
  "discord",
  "meta",
  "salesforce",
  "zendesk",
  "hubspot",
  "snowflake",
  "mongodb",
  "mysql",
  "supabase",
  "clickhouse",
  "databricks",
  "elasticsearch",
  "firestore",
  "turso",
  "airtable",
  "redis_db",
  "dynamodb",
  "graphql",
  "rest_api",
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectorDocument {
  sourceName: string;
  content: string;
  metadata: Record<string, string | number>;
}

export const ConnectorPayloadSchema = z.object({
  type: z.enum(CONNECTOR_TYPES),
  // Web / Sitemap
  url: z.string().optional(),
  maxPages: z.number().int().min(1).max(25).optional(),
  // GitHub
  repo: z.string().optional(),
  branch: z.string().optional(),
  pathPrefix: z.string().optional(),
  includeIssues: z.boolean().optional(),
  // Shared API auth
  apiToken: z.string().optional(),
  email: z.string().optional(),
  baseUrl: z.string().optional(),
  // Notion / Confluence / Jira / Asana / Linear / Slack
  query: z.string().optional(),
  spaceKey: z.string().optional(),
  jql: z.string().optional(),
  projectId: z.string().optional(),
  teamId: z.string().optional(),
  channelId: z.string().optional(),
  // S3 / MinIO
  bucket: z.string().optional(),
  prefix: z.string().optional(),
  region: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  endpoint: z.string().optional(),
  // Google Drive / SharePoint
  folderId: z.string().optional(),
  siteId: z.string().optional(),
  driveId: z.string().optional(),
  // PostgreSQL & Universal Databases / APIs
  connectionString: z.string().optional(),
  tables: z.array(z.string().regex(/^[a-zA-Z0-9_.]+$/)).optional(),
  sqlQuery: z.string().optional(),
  maxRows: z.number().int().min(1).max(500).optional(),
  warehouseId: z.string().optional(),
  tableName: z.string().optional(),
  indexName: z.string().optional(),
  keyPattern: z.string().optional(),
  authHeaderName: z.string().optional(),
});

export type ConnectorPayload = z.infer<typeof ConnectorPayloadSchema>;

/**
 * SSRF-guarded fetch wrapper with strict timeout for all external enterprise connectors.
 */
export async function safeFetch(url: string, init?: RequestInit, timeoutMs: number = 15000): Promise<Response> {
  if (!validateSafeUrl(url)) {
    throw new Error("Blocked unsafe or private network URL");
  }
  return await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseCsv(text: string): string {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return "";
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          cur += "\"";
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1, 501).map((line, idx) => {
    const vals = parseLine(line);
    const pairs = headers.map((h, i) => `${h || `col_${i + 1}`}: ${vals[i] ?? ""}`);
    return `Row ${idx + 1}: ${pairs.join(" | ")}`;
  });
  return `Columns: ${headers.join(", ")}\n${rows.join("\n")}`;
}

export function sanitizeConnectorSourceName(raw: string): string {
  const cleaned = raw
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9_\-\.\s()]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim();
  return (cleaned || "connector-doc").slice(0, 120);
}

const FORBIDDEN_SQL_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|copy|execute|call|do|replace|rename|attach|detach)\b/i;

export function assertReadOnlySelect(sql: string, fallback?: string): string {
  const raw = (sql || fallback || "").trim().replace(/;+$/, "");
  if (!raw) throw new Error("SQL query is required");
  if (raw.includes(";")) throw new Error("Multiple SQL statements are prohibited");
  if (!/^(select|with|show|describe)\b/i.test(raw)) {
    throw new Error("Only read-only SELECT queries are permitted");
  }
  if (FORBIDDEN_SQL_WORDS.test(raw)) {
    throw new Error("Disallowed SQL keyword detected in query");
  }
  return raw;
}
