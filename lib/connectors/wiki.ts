import { ConnectorDocument, ConnectorPayload, htmlToText, safeFetch, sanitizeConnectorSourceName } from "./types";

function extractNotionRichText(richText: any[]): string {
  if (!Array.isArray(richText)) return "";
  return richText.map(rt => rt?.plain_text || "").join("");
}

function extractNotionTitle(page: any): string {
  const props = page?.properties || {};
  for (const prop of Object.values<any>(props)) {
    if (prop?.type === "title") {
      const t = extractNotionRichText(prop.title);
      if (t) return t;
    }
  }
  return page?.id || "Untitled Notion Page";
}

export async function fetchNotionConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const token = input.apiToken?.trim() || process.env.NOTION_API_KEY;
  if (!token) throw new Error("Notion API token is required (UI or NOTION_API_KEY env)");

  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };

  const searchRes = await safeFetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: input.query || "",
      filter: { property: "object", value: "page" },
      page_size: 15,
    }),
  });
  if (!searchRes.ok) {
    throw new Error(`Notion search failed (${searchRes.status})`);
  }
  const searchData = await searchRes.json();
  const pages = Array.isArray(searchData?.results) ? searchData.results : [];
  const docs: ConnectorDocument[] = [];

  for (const page of pages) {
    const title = extractNotionTitle(page);
    const blocksRes = await safeFetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
      headers,
    });
    if (!blocksRes.ok) continue;
    const blocksData = await blocksRes.json();
    const lines: string[] = [];

    for (const block of blocksData?.results || []) {
      const blockData = block?.[block.type];
      const text = extractNotionRichText(blockData?.rich_text);
      if (text) lines.push(text);
    }

    if (lines.length === 0) continue;
    docs.push({
      sourceName: sanitizeConnectorSourceName(`notion_${title}.md`),
      content: `# ${title}\n\n${lines.join("\n\n")}`,
      metadata: { source: page.url || page.id, section: title.slice(0, 80), page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No Notion pages with text blocks matched");
  return docs;
}

export async function fetchConfluenceConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  const baseUrl = (input.baseUrl?.trim() || process.env.CONFLUENCE_BASE_URL || "").replace(/\/+$/, "");
  const email = input.email?.trim() || process.env.CONFLUENCE_EMAIL || "";
  const token = input.apiToken?.trim() || process.env.CONFLUENCE_API_TOKEN || "";

  if (!baseUrl || !token) {
    throw new Error("Confluence Base URL and API Token are required");
  }

  const authHeader = email
    ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
    : `Bearer ${token}`;

  const cqlParts: string[] = ['type="page"'];
  if (input.spaceKey?.trim()) cqlParts.push(`space="${input.spaceKey.trim()}"`);
  if (input.query?.trim()) cqlParts.push(`text ~ "${input.query.trim().replace(/"/g, "")}"`);
  const cql = encodeURIComponent(cqlParts.join(" AND "));

  const res = await safeFetch(`${baseUrl}/wiki/rest/api/content/search?cql=${cql}&expand=body.storage&limit=20`, {
    headers: { Authorization: authHeader, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Confluence API failed (${res.status})`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const docs: ConnectorDocument[] = [];

  for (const item of results) {
    const html = item?.body?.storage?.value || "";
    const text = htmlToText(html);
    if (!text) continue;
    const title = item.title || item.id;
    docs.push({
      sourceName: sanitizeConnectorSourceName(`confluence_${title}.md`),
      content: `# ${title}\n\n${text}`,
      metadata: { source: `${baseUrl}/wiki${item._links?.webui || ""}`, section: title.slice(0, 80), page: 1 },
    });
  }

  if (docs.length === 0) throw new Error("No Confluence pages matched");
  return docs;
}
