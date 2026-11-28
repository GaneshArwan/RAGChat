import crypto from "crypto";
import { Document } from "@langchain/core/documents";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { ChromaClient } from "chromadb";
import { Embeddings } from "@langchain/core/embeddings";
import { AppConfig, validateSafeUrl } from "./config";
import { getEmbeddings, getChromaClient, getChromaUrl } from "./embeddings";
import { hasDocumentAccess } from "./security";
import { sanitizeLog } from "./validation";

export interface IVectorStoreAdapter {
  provider: "chroma" | "qdrant" | "pinecone";
  indexDocuments(docs: Document[]): Promise<void>;
  similaritySearchWithScore(
    query: string,
    k: number,
    filenames: string[],
    tenantId: string,
    userRoles: string[]
  ): Promise<Array<[Document, number]>>;
  getAllByFilenames(
    filenames: string[],
    tenantId: string,
    userRoles: string[],
    limit?: number
  ): Promise<Document[]>;
  listDocuments(tenantId: string, userRoles: string[]): Promise<string[]>;
  deleteByFilename(filename: string, tenantId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

class NoOpEmbeddings extends Embeddings {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
  async embedQuery(): Promise<number[]> {
    return [];
  }
}

class ChromaAdapter implements IVectorStoreAdapter {
  provider: "chroma" = "chroma";
  private config?: AppConfig;
  private collectionName: string;

  constructor(config?: AppConfig) {
    this.config = config;
    this.collectionName = config?.vectorStoreIndex || "rag-chat";
  }

  private async getStore(readOnly: boolean = false) {
    const url = getChromaUrl();
    const embeddings = readOnly || !this.config ? new NoOpEmbeddings({}) : getEmbeddings(this.config);
    return await Chroma.fromExistingCollection(embeddings, {
      collectionName: this.collectionName,
      index: getChromaClient(url),
    });
  }

  async indexDocuments(docs: Document[]): Promise<void> {
    if (!this.config) throw new Error("Configuration is required for indexing");
    const embeddings = getEmbeddings(this.config);
    const url = getChromaUrl();
    await Chroma.fromDocuments(docs, embeddings, {
      collectionName: this.collectionName,
      index: getChromaClient(url),
    });
  }

  async similaritySearchWithScore(
    query: string,
    k: number,
    filenames: string[],
    tenantId: string,
    userRoles: string[]
  ): Promise<Array<[Document, number]>> {
    const store = await this.getStore(false);
    // Over-fetch slightly so post-ACL filtering retains enough candidates
    const results = await store.similaritySearchWithScore(query, Math.min(50, k * 2), {
      filename: { $in: filenames },
    });
    return results
      .filter(([doc]) => hasDocumentAccess(doc.metadata, tenantId, userRoles))
      .slice(0, k);
  }

  async getAllByFilenames(
    filenames: string[],
    tenantId: string,
    userRoles: string[],
    limit: number = 2000
  ): Promise<Document[]> {
    const url = getChromaUrl();
    const client = getChromaClient(url);
    let collection;
    try {
      collection = await client.getCollection({ name: this.collectionName });
    } catch {
      return [];
    }
    const response = await collection.get({
      where: { filename: { $in: filenames } },
      limit,
    });
    const docs: Document[] = (response.ids || []).map((_id: string, i: number) => ({
      pageContent: response.documents[i] || "",
      metadata: response.metadatas[i] || {},
    } as Document));

    return docs.filter(d => hasDocumentAccess(d.metadata, tenantId, userRoles));
  }

  async listDocuments(tenantId: string, userRoles: string[]): Promise<string[]> {
    const url = getChromaUrl();
    const client = getChromaClient(url);
    let collection;
    try {
      collection = await client.getCollection({ name: this.collectionName });
    } catch (err: any) {
      const msg = `${err?.name || ""} ${err?.message || ""}`.toLowerCase();
      if (msg.includes("notfound") || msg.includes("not found") || msg.includes("does not exist")) {
        return [];
      }
      throw err;
    }

    const results = await collection.get({ include: ["metadatas" as any] });
    const filenames = new Set<string>();
    results.metadatas?.forEach((meta: any) => {
      if (meta?.filename && hasDocumentAccess(meta, tenantId, userRoles)) {
        filenames.add(meta.filename);
      }
    });
    return Array.from(filenames);
  }

  async deleteByFilename(filename: string, tenantId: string): Promise<void> {
    const store = await this.getStore(true);
    const filter: any = tenantId === "default"
      ? { filename: { $eq: filename } }
      : { $and: [{ filename: { $eq: filename } }, { tenantId: { $eq: tenantId } }] };
    await store.delete({ filter });
  }

  async healthCheck(): Promise<boolean> {
    const url = getChromaUrl();
    const client = getChromaClient(url);
    await client.heartbeat();
    return true;
  }
}

export class QdrantAdapter implements IVectorStoreAdapter {
  provider: "qdrant" = "qdrant";
  private config?: AppConfig;
  private url: string;
  private apiKey?: string;
  private collection: string;

  constructor(config?: AppConfig) {
    this.config = config;
    const rawUrl = config?.vectorStoreUrl || process.env.QDRANT_URL || "";
    if (!rawUrl || !validateSafeUrl(rawUrl)) {
      throw new Error("Valid Qdrant URL is required");
    }
    this.url = rawUrl.replace(/\/+$/, "");
    this.apiKey = config?.vectorStoreApiKey || process.env.QDRANT_API_KEY;
    this.collection = config?.vectorStoreIndex || "rag-chat";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["api-key"] = this.apiKey;
    return h;
  }

  private async ensureCollection(vectorSize: number) {
    const check = await fetch(`${this.url}/collections/${encodeURIComponent(this.collection)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10000),
    });
    if (check.ok) return;
    if (check.status !== 404) {
      throw new Error(`Qdrant collection check failed (${check.status})`);
    }
    const createRes = await fetch(`${this.url}/collections/${encodeURIComponent(this.collection)}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ vectors: { size: vectorSize, distance: "Cosine" } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create Qdrant collection (${createRes.status})`);
    }
  }

  async indexDocuments(docs: Document[]): Promise<void> {
    if (!this.config || docs.length === 0) return;
    const embeddings = getEmbeddings(this.config);
    const vectors = await embeddings.embedDocuments(docs.map(d => d.pageContent));
    await this.ensureCollection(vectors[0].length);

    const points = docs.map((doc, idx) => ({
      id: crypto.randomUUID(),
      vector: vectors[idx],
      payload: {
        ...doc.metadata,
        pageContent: doc.pageContent,
      },
    }));

    const res = await fetch(`${this.url}/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ points }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`Qdrant upsert failed (${res.status})`);
    }
  }

  async similaritySearchWithScore(
    query: string,
    k: number,
    filenames: string[],
    tenantId: string,
    userRoles: string[]
  ): Promise<Array<[Document, number]>> {
    if (!this.config) throw new Error("Configuration required for Qdrant search");
    const embeddings = getEmbeddings(this.config);
    const vector = await embeddings.embedQuery(query);

    const res = await fetch(`${this.url}/collections/${encodeURIComponent(this.collection)}/points/search`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        vector,
        limit: Math.min(50, k * 2),
        with_payload: true,
        filter: {
          must: [
            { key: "tenantId", match: { value: tenantId } },
            { key: "filename", match: { any: filenames } },
          ],
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Qdrant search failed (${res.status})`);
    }
    const data = await res.json();
    const hits = Array.isArray(data?.result) ? data.result : [];
    const mapped: Array<[Document, number]> = [];
    for (const hit of hits) {
      const payload = hit?.payload || {};
      const { pageContent, ...meta } = payload;
      if (hasDocumentAccess(meta, tenantId, userRoles)) {
        const distance = Math.max(0, 1 - Number(hit.score ?? 0));
        mapped.push([new Document({ pageContent: String(pageContent || ""), metadata: meta }), distance]);
      }
    }
    return mapped.slice(0, k);
  }

  async getAllByFilenames(
    filenames: string[],
    tenantId: string,
    userRoles: string[],
    limit: number = 1000
  ): Promise<Document[]> {
    const res = await fetch(`${this.url}/collections/${encodeURIComponent(this.collection)}/points/scroll`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        limit,
        with_payload: true,
        filter: {
          must: [
            { key: "tenantId", match: { value: tenantId } },
            { key: "filename", match: { any: filenames } },
          ],
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const points = Array.isArray(data?.result?.points) ? data.result.points : [];
    return points
      .map((p: any) => {
        const { pageContent, ...meta } = p?.payload || {};
        return new Document({ pageContent: String(pageContent || ""), metadata: meta });
      })
      .filter((d: Document) => hasDocumentAccess(d.metadata, tenantId, userRoles));
  }

  async listDocuments(tenantId: string, userRoles: string[]): Promise<string[]> {
    const res = await fetch(`${this.url}/collections/${encodeURIComponent(this.collection)}/points/scroll`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        limit: 1000,
        with_payload: true,
        filter: { must: [{ key: "tenantId", match: { value: tenantId } }] },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const points = Array.isArray(data?.result?.points) ? data.result.points : [];
    const filenames = new Set<string>();
    for (const p of points) {
      const meta = p?.payload || {};
      if (meta?.filename && hasDocumentAccess(meta, tenantId, userRoles)) {
        filenames.add(meta.filename);
      }
    }
    return Array.from(filenames);
  }

  async deleteByFilename(filename: string, tenantId: string): Promise<void> {
    const res = await fetch(`${this.url}/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        filter: {
          must: [
            { key: "tenantId", match: { value: tenantId } },
            { key: "filename", match: { value: filename } },
          ],
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Qdrant delete failed (${res.status})`);
    }
  }

  async healthCheck(): Promise<boolean> {
    const res = await fetch(`${this.url}/healthz`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  }
}

export class PineconeAdapter implements IVectorStoreAdapter {
  provider: "pinecone" = "pinecone";
  private config?: AppConfig;
  private host: string;
  private apiKey: string;

  constructor(config?: AppConfig) {
    this.config = config;
    const rawHost = config?.vectorStoreUrl || process.env.PINECONE_INDEX_HOST || "";
    const apiKey = config?.vectorStoreApiKey || process.env.PINECONE_API_KEY || "";
    if (!rawHost || !validateSafeUrl(rawHost) || !apiKey) {
      throw new Error("Valid Pinecone index host URL and API key are required");
    }
    this.host = rawHost.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Api-Key": this.apiKey,
    };
  }

  async indexDocuments(docs: Document[]): Promise<void> {
    if (!this.config || docs.length === 0) return;
    const embeddings = getEmbeddings(this.config);
    const vectors = await embeddings.embedDocuments(docs.map(d => d.pageContent));
    const tenantId = this.config.tenantId || "default";

    const upserts = docs.map((doc, idx) => ({
      id: crypto.randomUUID(),
      values: vectors[idx],
      metadata: {
        ...doc.metadata,
        tenantId,
        text: doc.pageContent.slice(0, 35000),
      },
    }));

    const res = await fetch(`${this.host}/vectors/upsert`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ vectors: upserts, namespace: tenantId }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`Pinecone upsert failed (${res.status})`);
    }
  }

  async similaritySearchWithScore(
    query: string,
    k: number,
    filenames: string[],
    tenantId: string,
    userRoles: string[]
  ): Promise<Array<[Document, number]>> {
    if (!this.config) throw new Error("Configuration required for Pinecone search");
    const embeddings = getEmbeddings(this.config);
    const vector = await embeddings.embedQuery(query);

    const res = await fetch(`${this.host}/query`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        vector,
        topK: Math.min(50, k * 2),
        namespace: tenantId,
        includeMetadata: true,
        filter: { filename: { $in: filenames } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Pinecone query failed (${res.status})`);
    }
    const data = await res.json();
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    const results: Array<[Document, number]> = [];
    for (const m of matches) {
      const meta = m?.metadata || {};
      if (hasDocumentAccess({ ...meta, tenantId }, tenantId, userRoles)) {
        const { text, ...rest } = meta;
        const distance = Math.max(0, 1 - Number(m.score ?? 0));
        results.push([new Document({ pageContent: String(text || ""), metadata: rest }), distance]);
      }
    }
    return results.slice(0, k);
  }

  async getAllByFilenames(
    filenames: string[],
    tenantId: string,
    userRoles: string[],
    limit: number = 100
  ): Promise<Document[]> {
    // Pinecone requires a vector for query; use vector listing when available
    try {
      const listRes = await fetch(
        `${this.host}/vectors/list?namespace=${encodeURIComponent(tenantId)}&limit=${Math.min(100, limit)}`,
        { headers: this.headers(), signal: AbortSignal.timeout(10000) }
      );
      if (!listRes.ok) return [];
      const listData = await listRes.json();
      const ids: string[] = (listData?.vectors || []).map((v: any) => v.id).filter(Boolean);
      if (ids.length === 0) return [];

      const params = new URLSearchParams({ namespace: tenantId });
      ids.forEach(id => params.append("ids", id));
      const fetchRes = await fetch(`${this.host}/vectors/fetch?${params.toString()}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(15000),
      });
      if (!fetchRes.ok) return [];
      const fetchData = await fetchRes.json();
      const vectors = fetchData?.vectors || {};
      const filenameSet = new Set(filenames);
      const docs: Document[] = [];
      for (const vec of Object.values<any>(vectors)) {
        const meta = vec?.metadata || {};
        if (filenameSet.has(meta.filename) && hasDocumentAccess({ ...meta, tenantId }, tenantId, userRoles)) {
          const { text, ...rest } = meta;
          docs.push(new Document({ pageContent: String(text || ""), metadata: rest }));
        }
      }
      return docs;
    } catch (err: any) {
      console.warn("[Pinecone] getAllByFilenames fallback:", sanitizeLog(err?.message || "Unknown error"));
      return [];
    }
  }

  async listDocuments(tenantId: string, userRoles: string[]): Promise<string[]> {
    try {
      const listRes = await fetch(
        `${this.host}/vectors/list?namespace=${encodeURIComponent(tenantId)}&limit=100`,
        { headers: this.headers(), signal: AbortSignal.timeout(10000) }
      );
      if (!listRes.ok) return [];
      const listData = await listRes.json();
      const ids: string[] = (listData?.vectors || []).map((v: any) => v.id).filter(Boolean);
      if (ids.length === 0) return [];

      const params = new URLSearchParams({ namespace: tenantId });
      ids.forEach(id => params.append("ids", id));
      const fetchRes = await fetch(`${this.host}/vectors/fetch?${params.toString()}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10000),
      });
      if (!fetchRes.ok) return [];
      const fetchData = await fetchRes.json();
      const filenames = new Set<string>();
      for (const vec of Object.values<any>(fetchData?.vectors || {})) {
        const meta = vec?.metadata || {};
        if (meta?.filename && hasDocumentAccess({ ...meta, tenantId }, tenantId, userRoles)) {
          filenames.add(meta.filename);
        }
      }
      return Array.from(filenames);
    } catch {
      return [];
    }
  }

  async deleteByFilename(filename: string, tenantId: string): Promise<void> {
    const res = await fetch(`${this.host}/vectors/delete`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        namespace: tenantId,
        filter: { filename: { $eq: filename } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Pinecone delete failed (${res.status})`);
    }
  }

  async healthCheck(): Promise<boolean> {
    const res = await fetch(`${this.host}/describe_index_stats`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  }
}

export function getVectorStoreAdapter(config?: Partial<AppConfig>): IVectorStoreAdapter {
  const provider = config?.vectorStoreProvider || "chroma";
  const fullConfig = config as AppConfig | undefined;
  switch (provider) {
    case "qdrant":
      return new QdrantAdapter(fullConfig);
    case "pinecone":
      return new PineconeAdapter(fullConfig);
    case "chroma":
    default:
      return new ChromaAdapter(fullConfig);
  }
}
