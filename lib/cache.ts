import { GoogleAICacheManager } from "@google/generative-ai/server";
import { Redis as UpstashRedis } from "@upstash/redis";
import Redis, { RedisOptions } from "ioredis";
import { AppConfig, validateSafeUrl, isSafeHost } from "./config";
import crypto from "crypto";
import { sanitizeLog } from "./validation";

/**
 * UNIFIED CACHE ORCHESTRATOR (MULTI-PROVIDER DISTRIBUTED)
 * Handles prompt caching with Upstash (REST) or Standard Redis (TCP).
 */

interface IRedisClient {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: any, options?: { px: number }): Promise<any>;
}

class UpstashDriver implements IRedisClient {
  private client: UpstashRedis;
  constructor(url: string, token: string) { this.client = new UpstashRedis({ url, token }); }
  async get<T>(key: string) { return await this.client.get<T>(key); }
  async set(key: string, value: any, options?: { px: number }) { return await this.client.set(key, value, options); }
}

class StandardDriver implements IRedisClient {
  private client: Redis;
  constructor(options: string | RedisOptions) { this.client = new Redis(options as any); }
  async get<T>(key: string) {
    const val = await this.client.get(key);
    return val ? JSON.parse(val) as T : null;
  }
  async set(key: string, value: any, options?: { px: number }) {
    const str = JSON.stringify(value);
    if (options?.px) return await this.client.set(key, str, "PX", options.px);
    return await this.client.set(key, str);
  }
}

function getRedisClient(config: AppConfig): IRedisClient | null {
  if (config.useRedis === false) return null;
  const provider = config.redisProvider || "upstash";
  const url = config.redisUrl;
  const token = config.redisToken;

  if (provider === "upstash") {
    const finalUrl = url || process.env.UPSTASH_REDIS_REST_URL;
    const finalToken = token || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (finalUrl && finalToken) {
      if (!validateSafeUrl(finalUrl)) {
        console.error("[Cache] Invalid or unsafe Upstash URL:", sanitizeLog(finalUrl));
        return null;
      }
      return new UpstashDriver(finalUrl, finalToken);
    }
  }

  if (provider === "standard") {
    if (url) {
      if (!validateSafeUrl(url)) {
        console.error("[Cache] Invalid or unsafe Redis connection URL:", sanitizeLog(url));
        return null;
      }
      return new StandardDriver(url);
    }
    if (config.redisHost) {
      if (!isSafeHost(config.redisHost)) {
        console.error("[Cache] Unsafe Redis host:", sanitizeLog(config.redisHost));
        return null;
      }
      const options: RedisOptions = {
        host: config.redisHost,
        port: config.redisPort || 6379,
        password: config.redisPassword,
        db: config.redisDb || 0,
        tls: config.redisTls ? {} : undefined,
      };
      return new StandardDriver(options);
    }
  }
  return null;
}

const localGeminiCacheRegistry = new Map<string, { resourceName: string, expiresAt: number }>();

function getContextHash(context: string, config: AppConfig): string {
  const data = `${config.provider}-${config.modelId}-${context}`;
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function getCachedResource(hash: string, config: AppConfig): Promise<{ resourceName: string, expiresAt: number } | null> {
  const redis = getRedisClient(config);
  if (redis) {
    try {
      const data = await redis.get<{ resourceName: string, expiresAt: number }>(`cache:${hash}`);
      if (data && data.expiresAt > Date.now()) return data;
    } catch (e: any) { console.error("[Cache] Redis lookup failed:", sanitizeLog(e.message || "Unknown error")); }
  }
  const existing = localGeminiCacheRegistry.get(hash);
  if (existing && existing.expiresAt > Date.now()) return existing;
  return null;
}

async function registerCachedResource(hash: string, resourceName: string, ttlMs: number, config: AppConfig) {
  const data = { resourceName, expiresAt: Date.now() + ttlMs };
  const redis = getRedisClient(config);
  if (redis) {
    try {
      await redis.set(`cache:${hash}`, data, { px: ttlMs });
    } catch (e: any) { console.error("[Cache] Redis registration failed:", sanitizeLog(e.message || "Unknown error")); }
  }
  localGeminiCacheRegistry.set(hash, data);
}

export async function getOrCreateGeminiCache(context: string, config: AppConfig) {
  if (config.provider !== "gemini" || !config.apiKey) return null;
  const hash = getContextHash(context, config);
  const cached = await getCachedResource(hash, config);
  if (cached) {
    console.log(`[Cache] Gemini cache hit (Distributed) for hash: ${hash.substring(0, 8)}`);
    return cached.resourceName;
  }

  console.log(`[Cache] Gemini cache miss. Creating LIVE resource...`);
  const cacheManager = new GoogleAICacheManager(config.apiKey);
  try {
    const cacheTtlSeconds = config.redisCacheTtl || 3600;
    const cache = await cacheManager.create({
      model: config.modelId,
      contents: [{ role: "user", parts: [{ text: context }] }],
      ttlSeconds: cacheTtlSeconds,
    });
    const resourceName = cache.name;
    if (!resourceName) throw new Error("API returned an empty cache name");
    console.log(`[Cache] Gemini cache created: ${resourceName} (TTL: ${cacheTtlSeconds}s)`);
    await registerCachedResource(hash, resourceName, (cacheTtlSeconds - 60) * 1000, config);
    return resourceName;
  } catch (error: any) {
    if (error.message?.includes("429")) console.warn("[Cache] Gemini Cache limit exceeded (Free Tier).");
    else console.error("[Cache] Failed to create Gemini cache:", sanitizeLog(error.message || String(error)));
    return null;
  }
}

export async function wrapWithProviderCache(
  messages: any[],
  systemPrompt: string,
  config: AppConfig
): Promise<{ systemPrompt: string, messages: any[] }> {
  switch (config.provider) {
    case "anthropic":
      return { systemPrompt, messages };
    case "gemini":
      const resourceName = await getOrCreateGeminiCache(systemPrompt, config);
      if (resourceName) {
        return {
          systemPrompt,
          messages: messages.map((m, i) => i === 0 ? {
            ...m,
            experimental_providerMetadata: { google: { cachedContent: resourceName } }
          } : m)
        };
      }
      return { systemPrompt, messages };
    default:
      return { systemPrompt, messages };
  }
}
