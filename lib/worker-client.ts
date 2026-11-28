import { Document } from "@langchain/core/documents";
import { validateSafeUrl } from "./config";
import { bm25Search } from "./rag-pipeline";
import { sanitizeLog } from "./validation";

function getWorkerBaseUrl(): string | null {
  const url = process.env.WORKER_URL?.trim();
  if (!url || !validateSafeUrl(url)) return null;
  return url.replace(/\/+$/, "");
}

/**
 * Delegates Okapi BM25 scoring to the polyglot Go worker sidecar when WORKER_URL
 * is configured and healthy; seamlessly falls back to in-process TS BM25.
 */
export async function bm25ViaWorkerOrLocal(
  query: string,
  docs: Document[],
  limit = 15
): Promise<Document[]> {
  if (docs.length === 0) return [];
  const workerUrl = getWorkerBaseUrl();
  if (!workerUrl) {
    return bm25Search(query, docs, limit).map((r) => r.doc);
  }

  try {
    const idToDoc = new Map<string, Document>();
    const payloadDocs = docs.map((d, idx) => {
      const id = `${idx}`;
      idToDoc.set(id, d);
      return { id, content: d.pageContent };
    });

    const res = await fetch(`${workerUrl}/v1/bm25`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents: payloadDocs, limit }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Worker HTTP ${res.status}`);

    const data = (await res.json()) as { hits?: Array<{ id: string; score: number }> };
    if (!Array.isArray(data.hits)) throw new Error("Malformed worker BM25 response");

    const matched: Document[] = [];
    for (const hit of data.hits) {
      const doc = idToDoc.get(String(hit.id));
      if (doc) matched.push(doc);
    }
    return matched;
  } catch (err: any) {
    console.warn(`[WorkerClient] Go worker fallback to TS BM25: ${sanitizeLog(err?.message || "unavailable")}`);
    return bm25Search(query, docs, limit).map((r) => r.doc);
  }
}

export async function isWorkerHealthy(): Promise<boolean> {
  const workerUrl = getWorkerBaseUrl();
  if (!workerUrl) return false;
  try {
    const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
