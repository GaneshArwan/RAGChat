import { Redis as UpstashRedis } from "@upstash/redis";
import Redis, { RedisOptions } from "ioredis";
import { AppConfig, validateSafeUrl, isSafeHost } from "./config";
import { sanitizeLog } from "./validation";

/**
 * DISTRIBUTED RATE LIMITING (MULTI-PROVIDER)
 * Supports Upstash (REST) and Standard Redis (TCP).
 */

interface IRedisClient {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: any, options?: { px: number }): Promise<any>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<any>;
}

class UpstashDriver implements IRedisClient {
  private client: UpstashRedis;
  constructor(url: string, token: string) { this.client = new UpstashRedis({ url, token }); }
  async get<T>(key: string) { return await this.client.get<T>(key); }
  async set(key: string, value: any, options?: { px: number }) { return await this.client.set(key, value, options); }
  async incr(key: string) { return await this.client.incr(key); }
  async pexpire(key: string, ms: number) { return await this.client.pexpire(key, ms); }
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
  async incr(key: string) { return await this.client.incr(key); }
  async pexpire(key: string, ms: number) { return await this.client.pexpire(key, ms); }
}

function getRedisClient(config?: AppConfig): IRedisClient | null {
  if (!config || config.useRedis === false) return null;
  
  const provider = config.redisProvider || "upstash";
  const url = config.redisUrl;
  const token = config.redisToken;

  // 1. Upstash (REST)
  if (provider === "upstash") {
    const finalUrl = url || process.env.UPSTASH_REDIS_REST_URL;
    const finalToken = token || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (finalUrl && finalToken) {
      if (!validateSafeUrl(finalUrl)) {
        console.error("[RateLimit] Invalid or unsafe Upstash URL:", sanitizeLog(finalUrl));
        return null;
      }
      return new UpstashDriver(finalUrl, finalToken);
    }
  }

  // 2. Standard Redis (TCP)
  if (provider === "standard") {
    // If URL is provided, it takes precedence as it's a full connection string
    if (url) {
      if (!validateSafeUrl(url)) {
        console.error("[RateLimit] Invalid or unsafe Redis connection URL:", sanitizeLog(url));
        return null;
      }
      return new StandardDriver(url);
    }

    // Otherwise, build from individual fields
    if (config.redisHost) {
      if (!isSafeHost(config.redisHost)) {
        console.error("[RateLimit] Unsafe Redis host:", sanitizeLog(config.redisHost));
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



const localRateLimitMap = new Map<string, { count: number; lastReset: number }>();

export async function rateLimit(ip: string, config?: AppConfig, limit: number = 20, windowMs: number = 60000) {
  const redis = getRedisClient(config);
  const effectiveTtlMs = config?.redisRateLimitTtl ? config.redisRateLimitTtl * 1000 : windowMs;

  if (redis) {
    const key = `ratelimit:${ip}`;
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.pexpire(key, effectiveTtlMs);
      }
      return current <= limit;
    } catch (error: any) {
      console.error("[RateLimit] Redis error, fallback to memory:", sanitizeLog(error.message || "Unknown error"));
    }
  }

  const now = Date.now();
  const userData = localRateLimitMap.get(ip) || { count: 0, lastReset: now };
  if (now - userData.lastReset > windowMs) {
    userData.count = 0;
    userData.lastReset = now;
  }
  userData.count++;
  localRateLimitMap.set(ip, userData);
  return userData.count <= limit;
}
