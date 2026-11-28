import { Document } from "@langchain/core/documents";
import { generateText } from "ai";
import { AppConfig } from "./config";
import { getModelProvider } from "./models";
import { sanitizeLog } from "./validation";
import type { IVectorStoreAdapter } from "./vector-store";
import { PipelineTracer, StageTrace } from "./telemetry";
import { queryGraphContext } from "./graph-rag";
import { bm25ViaWorkerOrLocal } from "./worker-client";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he",
  "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were", "will",
  "with", "what", "which", "who", "whom", "this", "these", "those", "can", "could",
  "should", "would", "do", "does", "did", "how", "why", "when", "where", "or", "not",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(tok => tok.length > 1 && !STOPWORDS.has(tok));
}

export function getDocKey(doc: Document): string {
  const filename = doc.metadata?.filename || "";
  const page = doc.metadata?.page ?? "";
  const chunkIdx = doc.metadata?.chunkIndex;
  if (chunkIdx !== undefined && chunkIdx !== null) {
    return `${filename}::${page}::${chunkIdx}`;
  }
  return `${filename}::${page}::${doc.pageContent.trim().slice(0, 120)}`;
}

/**
 * Okapi BM25 lexical search over active document chunks.
 * Captures exact identifiers, error codes, SKUs, and terminology missed by dense vectors.
 */
export function bm25Search(
  query: string,
  docs: Document[],
  topK: number = 20,
  k1: number = 1.5,
  b: number = 0.75
): Array<{ doc: Document; score: number }> {
  if (docs.length === 0) return [];
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];

  const tokenizedDocs = docs.map(d => tokenize(d.pageContent));
  const totalLen = tokenizedDocs.reduce((sum, t) => sum + t.length, 0);
  const avgDocLen = totalLen / Math.max(1, docs.length);

  const docFreq = new Map<string, number>();
  for (const tokens of tokenizedDocs) {
    const unique = new Set(tokens);
    for (const term of queryTerms) {
      if (unique.has(term)) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
    }
  }

  const scored: Array<{ doc: Document; score: number }> = [];
  const N = docs.length;

  for (let i = 0; i < docs.length; i++) {
    const tokens = tokenizedDocs[i];
    if (tokens.length === 0) continue;

    const tfMap = new Map<string, number>();
    for (const tok of tokens) {
      tfMap.set(tok, (tfMap.get(tok) || 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const df = docFreq.get(term) || 0;
      if (df === 0) continue;
      const tf = tfMap.get(term) || 0;
      if (tf === 0) continue;

      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = tf + k1 * (1 - b + b * (tokens.length / avgDocLen));
      score += idf * ((tf * (k1 + 1)) / denom);
    }

    if (score > 0) {
      scored.push({ doc: docs[i], score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Reciprocal Rank Fusion (RRF): combines multiple ranked lists (dense query variants + BM25)
 * without score normalization using RRF(d) = sum(1 / (k + rank)).
 */
export function reciprocalRankFusion(rankedLists: Document[][], k: number = 60): Document[] {
  const scores = new Map<string, { doc: Document; rrf: number }>();

  for (const list of rankedLists) {
    const seenInList = new Set<string>();
    list.forEach((doc, idx) => {
      const key = getDocKey(doc);
      if (seenInList.has(key)) return;
      seenInList.add(key);

      const contribution = 1 / (k + idx + 1);
      const existing = scores.get(key);
      if (existing) {
        existing.rrf += contribution;
      } else {
        scores.set(key, { doc, rrf: contribution });
      }
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrf - a.rrf)
    .map(entry => entry.doc);
}

export async function rewriteAndExpandQuery(
  messages: Array<{ role: string; content: string }>,
  config: AppConfig
): Promise<{ standaloneQuery: string; queries: string[]; wasRewritten: boolean }> {
  const rawQuery = messages[messages.length - 1]?.content?.trim() || "";
  if (!rawQuery) {
    return { standaloneQuery: "", queries: [], wasRewritten: false };
  }

  try {
    const recentHistory = messages
      .slice(-6, -1)
      .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`)
      .join("\n");

    const model = getModelProvider(config);
    const { text } = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 200,
      abortSignal: AbortSignal.timeout(8000),
      system:
        "You optimize search queries for a hybrid vector + BM25 retrieval system. " +
        "Return ONLY valid JSON: {\"standalone\":\"...\",\"variants\":[\"...\",\"...\"]}. " +
        "Resolve pronouns/references from conversation history into a self-contained search query in 'standalone', " +
        "and provide up to 2 concise lexical/semantic search variants in 'variants'. Keep exact filenames, codes, and terms intact.",
      prompt: `${recentHistory ? `History:\n${recentHistory}\n\n` : ""}Latest question: ${rawQuery}`,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { standaloneQuery: rawQuery, queries: [rawQuery], wasRewritten: false };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const standalone = typeof parsed?.standalone === "string" && parsed.standalone.trim()
      ? parsed.standalone.trim()
      : rawQuery;
    const variants: string[] = Array.isArray(parsed?.variants)
      ? parsed.variants.filter((v: any) => typeof v === "string" && v.trim()).map((v: string) => v.trim()).slice(0, 2)
      : [];

    const queries = Array.from(new Set([standalone, ...variants, rawQuery])).slice(0, 3);
    return {
      standaloneQuery: standalone,
      queries,
      wasRewritten: standalone.toLowerCase() !== rawQuery.toLowerCase() || variants.length > 0,
    };
  } catch (err: any) {
    console.warn("[RAG] Query rewrite skipped:", sanitizeLog(err?.message || "Unknown error"));
    return { standaloneQuery: rawQuery, queries: [rawQuery], wasRewritten: false };
  }
}

export async function rerankDocuments(
  query: string,
  docs: Document[],
  config: AppConfig,
  rerankKey: string,
  rerankBaseUrl?: string,
  topN: number = 5
): Promise<{ docs: Document[]; reranked: boolean }> {
  if (!config.useReranking || docs.length <= 1) {
    return { docs: docs.slice(0, topN), reranked: false };
  }
  const provider = config.rerankProvider || "default";
  if (provider === "default") {
    return { docs: docs.slice(0, topN), reranked: false };
  }

  try {
    let endpoint = "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let payload: Record<string, any> = {};

    if (provider === "cohere") {
      endpoint = config.rerankBaseUrl || "https://api.cohere.com/v2/rerank";
      if (rerankKey) headers["Authorization"] = `Bearer ${rerankKey}`;
      payload = {
        model: config.rerankModelId || "rerank-english-v3.0",
        query,
        documents: docs.map(d => d.pageContent),
        top_n: topN,
      };
    } else if (provider === "voyage") {
      endpoint = config.rerankBaseUrl || "https://api.voyageai.com/v1/rerank";
      if (rerankKey) headers["Authorization"] = `Bearer ${rerankKey}`;
      payload = {
        model: config.rerankModelId || "rerank-2",
        query,
        documents: docs.map(d => d.pageContent),
        top_k: topN,
      };
    } else if (provider === "custom" && rerankBaseUrl) {
      endpoint = rerankBaseUrl;
      if (rerankKey) headers["Authorization"] = `Bearer ${rerankKey}`;
      payload = {
        model: config.rerankModelId,
        query,
        documents: docs.map(d => d.pageContent),
        top_n: topN,
      };
    } else {
      return { docs: docs.slice(0, topN), reranked: false };
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[RAG] Rerank failed (${res.status}), falling back to top-${topN} RRF results.`);
      return { docs: docs.slice(0, topN), reranked: false };
    }

    const data = await res.json();
    const items: Array<{ index: number }> = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.data)
      ? data.data
      : [];

    const reranked = items
      .filter(item => typeof item?.index === "number" && item.index >= 0 && item.index < docs.length)
      .slice(0, topN)
      .map(item => docs[item.index]);

    return reranked.length > 0
      ? { docs: reranked, reranked: true }
      : { docs: docs.slice(0, topN), reranked: false };
  } catch (err: any) {
    console.warn("[RAG] Rerank error, falling back:", sanitizeLog(err?.message || "Unknown error"));
    return { docs: docs.slice(0, topN), reranked: false };
  }
}

export function dedupeDocs(docs: Document[]): Document[] {
  const seen = new Set<string>();
  const unique: Document[] = [];
  for (const doc of docs) {
    const key = getDocKey(doc);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(doc);
    }
  }
  return unique;
}

export function sortDocsDeterministically(docs: Document[]): Document[] {
  return [...docs].sort((a, b) => {
    const nameDiff = (a.metadata?.filename || "").localeCompare(b.metadata?.filename || "");
    if (nameDiff !== 0) return nameDiff;
    const pageDiff = (a.metadata?.page || 0) - (b.metadata?.page || 0);
    if (pageDiff !== 0) return pageDiff;
    return (a.metadata?.chunkIndex || 0) - (b.metadata?.chunkIndex || 0);
  });
}

export function formatNumberedContext(docs: Document[], format: "json" | "toon"): string {
  const clean = (text: string) => text.replace(/<\|.*?\|>/g, "").trim();

  if (format === "json") {
    return JSON.stringify(
      docs.map((d, idx) => ({
        id: idx + 1,
        source: d.metadata?.filename || "unknown",
        page: d.metadata?.page || "N/A",
        ...(d.metadata?.section ? { section: d.metadata.section } : {}),
        content: clean(d.pageContent),
      })),
      null,
      2
    );
  }

  // TOON Formatting (Schema-First Tabular with 1-based citation IDs)
  const header = "sources{id, filename, page, section, content}:";
  const rows = docs
    .map((d, idx) => {
      const filename = d.metadata?.filename || "unknown";
      const page = d.metadata?.page || "N/A";
      const section = d.metadata?.section || "-";
      const content = clean(d.pageContent).replace(/\n/g, " ");
      return `  [${idx + 1}], ${filename}, ${page}, ${section}, ${content}`;
    })
    .join("\n");

  return `${header}\n${rows}`;
}

export async function decomposeQuery(
  query: string,
  messages: Array<{ role: string; content: string }>,
  config: AppConfig
): Promise<string[]> {
  try {
    const recent = messages
      .slice(-4, -1)
      .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const model = getModelProvider(config);
    const { text } = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 180,
      abortSignal: AbortSignal.timeout(7000),
      system:
        "Break complex or multi-part questions into 2 to 3 focused search sub-queries. " +
        "Return ONLY valid JSON: {\"subQueries\":[\"...\",\"...\"]}.",
      prompt: `${recent ? `History:\n${recent}\n\n` : ""}Question: ${query}`,
    });

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [query];
    const parsed = JSON.parse(match[0]);
    const list: string[] = Array.isArray(parsed?.subQueries)
      ? parsed.subQueries.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim()).slice(0, 3)
      : [];
    return list.length > 0 ? Array.from(new Set(list)) : [query];
  } catch {
    return [query];
  }
}

export interface RetrievalExecutionResult {
  docs: Document[];
  mode: string;
  rewrittenQuery: string;
  wasRewritten: boolean;
  denseHits: number;
  bm25Hits: number;
  graphHits: number;
  reranked: boolean;
  hops: number;
  subQueries: string[];
  trace: StageTrace;
}

/**
 * Executes single-pass or agentic multi-hop retrieval with per-stage latency tracing.
 */
export async function executeRetrievalPipeline(params: {
  messages: Array<{ role: string; content: string }>;
  rawQuery: string;
  adapter: IVectorStoreAdapter;
  filenames: string[];
  tenantId: string;
  userRoles: string[];
  config: AppConfig;
  rerankKey: string;
  rerankBaseUrl?: string;
}): Promise<RetrievalExecutionResult> {
  const { messages, rawQuery, adapter, filenames, tenantId, userRoles, config, rerankKey, rerankBaseUrl } = params;
  const tracer = new PipelineTracer();
  const threshold = config.similarityThreshold ?? 0.3;
  const topK = config.topK ?? 5;
  const useHybrid = config.useHybridSearch !== false;
  const useRewrite = config.useQueryRewrite !== false;
  const useAgentic = !!config.useAgenticRag;
  const distanceThreshold = (1 - threshold) * 2;
  const candidateK = config.useReranking ? 20 : Math.max(12, topK * 3);

  tracer.start("rewriteMs");
  let subQueries: string[] = [rawQuery];
  let standaloneQuery = rawQuery;
  let wasRewritten = false;

  if (useAgentic) {
    subQueries = await decomposeQuery(rawQuery, messages, config);
    standaloneQuery = subQueries[0] || rawQuery;
    wasRewritten = subQueries.length > 1 || standaloneQuery.toLowerCase() !== rawQuery.toLowerCase();
  } else if (useRewrite) {
    const rw = await rewriteAndExpandQuery(messages, config);
    subQueries = rw.queries;
    standaloneQuery = rw.standaloneQuery;
    wasRewritten = rw.wasRewritten;
  }
  tracer.end("rewriteMs");

  tracer.start("denseMs");
  const denseRawLists = await Promise.all(
    subQueries.map(q =>
      adapter.similaritySearchWithScore(q, candidateK, filenames, tenantId, userRoles)
    )
  );
  tracer.end("denseMs");

  let bm25Docs: Document[] = [];
  let allActiveDocs: Document[] = [];
  if (useHybrid) {
    tracer.start("bm25Ms");
    allActiveDocs = await adapter.getAllByFilenames(filenames, tenantId, userRoles, 2000);
    const bm25Queries = useAgentic ? subQueries : [standaloneQuery];
    const bm25Lists = await Promise.all(
      bm25Queries.map(q => bm25ViaWorkerOrLocal(q, allActiveDocs, 15))
    );
    bm25Docs = dedupeDocs(bm25Lists.flat()).slice(0, 20);
    tracer.end("bm25Ms");
  }

  const filteredDenseLists = denseRawLists.map(results =>
    results.filter(([, score]) => score <= distanceThreshold).map(([doc]) => doc)
  );
  let denseHitCount = filteredDenseLists.reduce((sum, list) => sum + list.length, 0);

  const rankedLists: Document[][] = [...filteredDenseLists.filter(l => l.length > 0)];
  if (bm25Docs.length > 0) rankedLists.push(bm25Docs);
  if (rankedLists.length === 0 && denseRawLists[0]?.length > 0) {
    rankedLists.push(denseRawLists[0].slice(0, topK).map(([doc]) => doc));
  }

  // Hop 2 (Agentic Corrective Hop): check if key query tokens are missing from Hop 1 pool
  let hops = 1;
  if (useAgentic) {
    const hop1Text = rankedLists.flat().map(d => d.pageContent).join(" ");
    const hop1Tokens = new Set(tokenize(hop1Text));
    const missingTerms = tokenize(rawQuery).filter(t => t.length > 3 && !hop1Tokens.has(t));
    if (missingTerms.length > 0) {
      hops = 2;
      const correctiveQuery = missingTerms.slice(0, 6).join(" ");
      tracer.start("denseMs");
      const hop2Dense = await adapter.similaritySearchWithScore(
        correctiveQuery,
        Math.max(8, topK * 2),
        filenames,
        tenantId,
        userRoles
      );
      tracer.end("denseMs");
      const hop2Filtered = hop2Dense.filter(([, s]) => s <= distanceThreshold).map(([d]) => d);
      if (hop2Filtered.length > 0) {
        rankedLists.push(hop2Filtered);
        denseHitCount += hop2Filtered.length;
      }
      if (useHybrid && allActiveDocs.length > 0) {
        tracer.start("bm25Ms");
        const hop2Bm25 = await bm25ViaWorkerOrLocal(correctiveQuery, allActiveDocs, 10);
        tracer.end("bm25Ms");
        if (hop2Bm25.length > 0) rankedLists.push(hop2Bm25);
      }
    }
  }

  tracer.start("rrfMs");
  const fusedPool = reciprocalRankFusion(rankedLists, 60).slice(0, 20);
  tracer.end("rrfMs");

  tracer.start("rerankMs");
  const rerankResult = config.useReranking && fusedPool.length > 1
    ? await rerankDocuments(standaloneQuery, fusedPool, config, rerankKey, rerankBaseUrl, topK)
    : { docs: fusedPool.slice(0, topK), reranked: false };
  tracer.end("rerankMs");

  const finalDocs = sortDocsDeterministically(dedupeDocs(rerankResult.docs));
  let graphHits = 0;
  if (config.useGraphRag) {
    const graphResult = queryGraphContext(standaloneQuery || rawQuery, tenantId, filenames, 10);
    graphHits = graphResult.edges.length;
    if (graphResult.summary) {
      finalDocs.unshift(
        new Document({
          pageContent: graphResult.summary,
          metadata: {
            filename: graphResult.edges[0]?.docName || filenames[0] || "knowledge-graph",
            page: "Graph",
            section: "Entity Relationship Graph",
            chunkIndex: -1,
          },
        })
      );
    }
  }

  const mode = useAgentic
    ? (useHybrid ? "AGENTIC HYBRID" : "AGENTIC DENSE")
    : (useHybrid ? "HYBRID RRF" : "DENSE");

  return {
    docs: finalDocs,
    mode,
    rewrittenQuery: standaloneQuery,
    wasRewritten,
    denseHits: denseHitCount,
    bm25Hits: bm25Docs.length,
    graphHits,
    reranked: rerankResult.reranked,
    hops,
    subQueries,
    trace: tracer.finish(),
  };
}
