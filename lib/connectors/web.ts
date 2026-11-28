import { ConnectorDocument, ConnectorPayload, htmlToText, safeFetch, sanitizeConnectorSourceName } from "./types";

function extractLinksFromSitemap(xml: string, maxPages: number): string[] {
  const urls: string[] = [];
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
  for (const m of matches) {
    if (urls.length >= maxPages) break;
    urls.push(m[1].trim());
  }
  return urls;
}

function extractLinksFromHtml(html: string, baseUrl: string, maxPages: number): string[] {
  const base = new URL(baseUrl);
  const links = new Set<string>();
  const matches = html.matchAll(/href=["']([^"'#]+)["']/gi);
  for (const m of matches) {
    if (links.size >= maxPages) break;
    try {
      const resolved = new URL(m[1], base);
      if (resolved.origin === base.origin && !/\.(png|jpg|jpeg|gif|svg|css|js|ico|pdf|zip)$/i.test(resolved.pathname)) {
        links.add(resolved.toString());
      }
    } catch {
      // Ignore malformed href
    }
  }
  return Array.from(links);
}

export async function fetchWebConnector(input: ConnectorPayload): Promise<ConnectorDocument[]> {
  if (!input.url) throw new Error("Web URL is required");
  const maxPages = Math.min(25, input.maxPages || 5);
  const startUrl = input.url.trim();

  const initialRes = await safeFetch(startUrl, {
    headers: { "User-Agent": "RAGChat-Enterprise-Crawler/1.0" },
  });
  if (!initialRes.ok) {
    throw new Error(`Failed to fetch URL (${initialRes.status})`);
  }

  const contentType = initialRes.headers.get("content-type") || "";
  const body = await initialRes.text();

  const targets: string[] =
    contentType.includes("xml") || startUrl.endsWith(".xml")
      ? extractLinksFromSitemap(body, maxPages)
      : [startUrl, ...extractLinksFromHtml(body, startUrl, Math.max(0, maxPages - 1))];

  const uniqueTargets = Array.from(new Set(targets)).slice(0, maxPages);
  const docs: ConnectorDocument[] = [];

  for (const target of uniqueTargets) {
    try {
      const res = target === startUrl && !contentType.includes("xml")
        ? { ok: true, text: async () => body, headers: initialRes.headers }
        : await safeFetch(target, { headers: { "User-Agent": "RAGChat-Enterprise-Crawler/1.0" } });

      if (!res.ok) continue;
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : target;
      const text = htmlToText(html);
      if (text.length < 40) continue;

      docs.push({
        sourceName: sanitizeConnectorSourceName(`${new URL(target).hostname}_${new URL(target).pathname}.txt`),
        content: `# ${title}\nURL: ${target}\n\n${text.slice(0, 50000)}`,
        metadata: { source: target, section: title.slice(0, 80), page: 1 },
      });
    } catch {
      // Skip unreachable sub-pages without failing whole crawl
    }
  }

  if (docs.length === 0) {
    throw new Error("No extractable text content found at URL");
  }
  return docs;
}
