import { ConnectorDocument, ConnectorPayload, safeFetch, sanitizeConnectorSourceName } from "./types";

export function assertReadOnlyGraphql(query: string): string {
  const trimmed = (query || "").trim();
  if (!trimmed) throw new Error("GraphQL query is required");
  if (/^\s*(mutation|subscription)\b/i.test(trimmed) || /\bmutation\s*\{/i.test(trimmed)) {
    throw new Error("Only read-only GraphQL queries are permitted");
  }
  return trimmed;
}

export async function fetchGraphqlConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const endpoint = input.url?.trim() || input.baseUrl?.trim() || "";
  if (!endpoint) throw new Error("GraphQL endpoint URL is required");
  const query = assertReadOnlyGraphql(input.sqlQuery || input.query || "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (input.apiToken?.trim()) {
    const headerName = input.authHeaderName?.trim() || "Authorization";
    headers[headerName] = headerName.toLowerCase() === "authorization"
      ? `Bearer ${input.apiToken.trim()}`
      : input.apiToken.trim();
  }

  const res = await safeFetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL endpoint failed (${res.status})`);
  const data = await res.json();
  if (data?.errors && !data?.data) {
    throw new Error(`GraphQL returned errors: ${JSON.stringify(data.errors)}`);
  }

  return [{
    sourceName: sanitizeConnectorSourceName(`graphql_${new URL(endpoint).hostname}.json`),
    content: `# GraphQL Response (${endpoint})\n\n${JSON.stringify(data?.data ?? data, null, 2).slice(0, 60000)}`,
    metadata: { source: endpoint, section: "GraphQL Query", page: 1 },
  }];
}

export async function fetchRestApiConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const endpoint = input.url?.trim() || input.baseUrl?.trim() || "";
  if (!endpoint) throw new Error("REST API endpoint URL is required");

  const headers: Record<string, string> = { Accept: "application/json, text/plain" };
  if (input.apiToken?.trim()) {
    const headerName = input.authHeaderName?.trim() || "Authorization";
    headers[headerName] = headerName.toLowerCase() === "authorization"
      ? `Bearer ${input.apiToken.trim()}`
      : input.apiToken.trim();
  }

  const res = await safeFetch(endpoint, { method: "GET", headers });
  if (!res.ok) throw new Error(`REST API failed (${res.status})`);
  const raw = await res.text();
  let formatted = raw;
  try {
    const parsed = JSON.parse(raw);
    formatted = Array.isArray(parsed)
      ? parsed.slice(0, input.maxRows || 200).map((item, i) => `Record ${i + 1}: ${JSON.stringify(item)}`).join("\n")
      : JSON.stringify(parsed, null, 2);
  } catch {
    // Plain text response
  }

  if (!formatted.trim()) throw new Error("REST API returned empty response");
  const parsedUrl = new URL(endpoint);
  return [{
    sourceName: sanitizeConnectorSourceName(`rest_${parsedUrl.hostname}_${parsedUrl.pathname}.txt`),
    content: `# REST API (${endpoint})\n\n${formatted.slice(0, 60000)}`,
    metadata: { source: endpoint, section: parsedUrl.pathname || "REST API", page: 1 },
  }];
}
