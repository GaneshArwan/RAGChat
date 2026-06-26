import { z } from "zod";

export function isSafeHost(hostname: string): boolean {
  hostname = hostname.toLowerCase().trim();
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("127.") ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("0.") ||
    hostname === "[::1]" ||
    hostname === "::1"
  ) {
    return false;
  }
  const privatePatterns = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
  ];
  if (privatePatterns.some(pattern => pattern.test(hostname))) return false;
  if (hostname.startsWith("[fc") || hostname.startsWith("[fd") || hostname.startsWith("[fe")) {
    return false;
  }
  return true;
}

export function validateSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "redis:", "rediss:"].includes(parsed.protocol)) return false;
    return isSafeHost(parsed.hostname);
  } catch {
    return false;
  }
}

export const ProviderSchema = z.enum(["gemini", "openai", "anthropic", "custom", "cohere", "voyage", "default"]);

const OptionalProvider = z.union([ProviderSchema, z.literal("")]).optional().transform(v => v === "" ? undefined : v);

export const ConfigSchema = z.object({
  provider: ProviderSchema,
  apiKey: z.string().optional(),
  modelId: z.string().min(1),
  baseUrl: z.string().optional(),
  
  // Embedding Overrides
  embeddingProvider: OptionalProvider,
  embeddingModelId: z.string().optional(),
  embeddingKeySource: z.enum(["main", "custom"]).default("main"),
  embeddingApiKey: z.string().optional(), // If empty, use apiKey
  embeddingBaseUrl: z.string().optional(), // Specific for local/custom embeddings
  
  // Reranking Controls
  useReranking: z.boolean().default(false),
  rerankProvider: OptionalProvider,
  rerankModelId: z.string().optional(),
  rerankKeySource: z.enum(["main", "embedding", "custom"]).default("main"),
  rerankApiKey: z.string().optional(), // If empty, use apiKey or fallback
  rerankBaseUrl: z.string().optional(), // Specific for local/custom reranking

  // CAG (Full Context) Controls
  useCag: z.boolean().default(false),

  // Safety & Quality
  similarityThreshold: z.number().min(0).max(1).default(0.3),
  contextFormat: z.enum(["json", "toon"]).default("toon"),

  // Distributed State (Ephemeral Infrastructure)
  useRedis: z.boolean().default(false),
  redisProvider: z.union([z.enum(["upstash", "standard"]), z.literal("")]).optional().transform(v => v === "" ? undefined : v),
  redisUrl: z.string().optional(), // Connection String / Base URL
  redisToken: z.string().optional(), // Upstash specific
  redisHost: z.string().optional(),
  redisPort: z.number().int().min(1).max(65535).default(6379),
  redisPassword: z.string().optional(),
  redisDb: z.number().min(0).max(15).default(0),
  redisTls: z.boolean().default(false),
  redisRateLimitTtl: z.number().min(1).default(60),
  redisCacheTtl: z.number().min(60).default(3600),
}).refine(data => {
  if (data.baseUrl && !validateSafeUrl(data.baseUrl)) return false;
  if (data.embeddingBaseUrl && !validateSafeUrl(data.embeddingBaseUrl)) return false;
  if (data.rerankBaseUrl && !validateSafeUrl(data.rerankBaseUrl)) return false;
  if (data.redisUrl && !validateSafeUrl(data.redisUrl)) return false;
  if (data.redisHost && !isSafeHost(data.redisHost)) return false;
  return true;
}, {
  message: "Unsafe URL or host detected. Local/private network access is prohibited in production.",
  path: ["baseUrl"]
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIGS: Record<string, Partial<AppConfig>> = {
  gemini: {
    modelId: "gemini-3-flash-preview",
    embeddingModelId: "gemini-embedding-2",
  },
  openai: {
    modelId: "gpt-4o-mini",
    embeddingModelId: "text-embedding-3-small",
  },
  anthropic: {
    modelId: "claude-3-5-sonnet-latest",
    embeddingModelId: "text-embedding-004",
  },
  custom: {
    modelId: "llama3",
    baseUrl: "http://localhost:11434/v1",
    embeddingProvider: "custom",
    embeddingModelId: "mxbai-embed-large",
    embeddingBaseUrl: "http://localhost:11434",
  },
  cohere: {
    rerankModelId: "rerank-english-v3.0",
  },
  voyage: {
    rerankModelId: "rerank-2",
  }
};
