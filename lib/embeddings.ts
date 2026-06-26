import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { OpenAIEmbeddings } from "@langchain/openai";
import { OllamaEmbeddings as LocalEmbeddings } from "@langchain/ollama";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { ChromaClient } from "chromadb";
import { AppConfig, validateSafeUrl } from "./config";
import { TaskType } from "@google/generative-ai";
import { Embeddings } from "@langchain/core/embeddings";

// Fake embeddings for deletion/management tasks that don't need actual vector math
class NoOpEmbeddings extends Embeddings {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
  async embedQuery(): Promise<number[]> {
    return [];
  }
}

function getChromaClient(url: string) {
  try {
    const parsed = new URL(url);
    return new ChromaClient({
      host: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
      ssl: parsed.protocol === "https:",
    });
  } catch (e) {
    return new ChromaClient({ path: url }); // Fallback
  }
}

export function getEmbeddings(config: AppConfig) {
  const provider = config.embeddingProvider || config.provider;
  const apiKey = config.embeddingApiKey || config.apiKey;
  const modelId = config.embeddingModelId;
  const baseUrl = config.embeddingBaseUrl || config.baseUrl;

  switch (provider) {
    case "gemini":
      return new GoogleGenerativeAIEmbeddings({
        apiKey: apiKey,
        modelName: modelId || "text-embedding-004",
        taskType: TaskType.RETRIEVAL_DOCUMENT,
      });
    case "openai":
      return new OpenAIEmbeddings({
        apiKey: apiKey,
        modelName: modelId || "text-embedding-3-small",
      });
    case "custom":
      return new LocalEmbeddings({
        baseUrl: baseUrl || "http://localhost:11434",
        model: modelId || "mxbai-embed-large",
      });
    default:
      throw new Error(`Unsupported embedding provider: ${provider}`);
  }
}

export async function getVectorStore(config: AppConfig) {
  const embeddings = getEmbeddings(config);
  const url = process.env.CHROMA_URL || "http://localhost:8000";
  
  if (process.env.NODE_ENV === "production") {
    if (!url) {
      throw new Error("CHROMA_URL must be set in production");
    }
    if (!validateSafeUrl(url)) {
      throw new Error("CHROMA_URL points to an unsafe destination");
    }
  }

  return await Chroma.fromExistingCollection(embeddings, {
    collectionName: "rag-chat",
    index: getChromaClient(url),
  });
}

export async function indexDocuments(docs: any[], config: AppConfig) {
  const embeddings = getEmbeddings(config);
  const url = process.env.CHROMA_URL || "http://localhost:8000";
  
  if (process.env.NODE_ENV === "production") {
    if (!url) {
      throw new Error("CHROMA_URL must be set in production");
    }
    if (!validateSafeUrl(url)) {
      throw new Error("CHROMA_URL points to an unsafe destination");
    }
  }

  return await Chroma.fromDocuments(docs, embeddings, {
    collectionName: "rag-chat",
    index: getChromaClient(url),
  });
}

export async function deleteDocumentsByFile(filename: string, config: AppConfig) {
  const embeddings = new NoOpEmbeddings({});
  const url = process.env.CHROMA_URL || "http://localhost:8000";
  
  const vectorStore = await Chroma.fromExistingCollection(embeddings, {
    collectionName: "rag-chat",
    index: getChromaClient(url),
  });

  await vectorStore.delete({
    filter: { filename: { $eq: filename } }
  });
}

export async function listDocuments() {
  const embeddings = new NoOpEmbeddings({});
  const url = process.env.CHROMA_URL || "http://localhost:8000";
  
  const client = getChromaClient(url);
  const collection = await client.getCollection({ name: "rag-chat" });
  
  // Get all metadata to extract unique filenames
  const results = await collection.get({
    include: ["metadatas" as any]
  });

  const filenames = new Set<string>();
  results.metadatas?.forEach((meta: any) => {
    if (meta.filename) filenames.add(meta.filename);
  });

  return Array.from(filenames);
}
