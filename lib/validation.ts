import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { AppConfig, validateSafeUrl, isSafeHost } from "./config";

export { validateSafeUrl, isSafeHost };

/**
 * Redacts sensitive API keys and passwords from error messages/logs.
 */
export function sanitizeLog(msg: string): string {
  if (!msg) return msg;
  // Redact API keys: match common API key patterns (e.g. sk-..., AIza...)
  let sanitized = msg.replace(/(sk-[a-zA-Z0-9]{20,})|(AIza[a-zA-Z0-9_-]{35})/g, "[REDACTED_KEY]");
  // Redact Redis/DB passwords in connection strings: e.g. redis://:password@host
  sanitized = sanitized.replace(/(redis|mongodb|postgresql|mysql):\/\/([^:]+):([^@]+)@/g, "$1://$2:[REDACTED_PASSWORD]@");
  sanitized = sanitized.replace(/:[^\s@]+@/g, ":[REDACTED_PASSWORD]@");
  return sanitized;
}

export async function validateApiKey(config: AppConfig): Promise<boolean> {
  try {
    switch (config.provider) {
      case "gemini": {
        if (!config.apiKey) return false;
        const genAI = new GoogleGenerativeAI(config.apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        await model.generateContent({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
        return true;
      }
      case "openai": {
        if (!config.apiKey) return false;
        const openai = new OpenAI({ apiKey: config.apiKey });
        await openai.models.list();
        return true;
      }
      case "anthropic": {
        if (!config.apiKey) return false;
        const anthropic = new Anthropic({ apiKey: config.apiKey });
        await anthropic.messages.create({
          model: "claude-3-5-sonnet-latest",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        return true;
      }
      case "custom": {
        if (!config.baseUrl || !validateSafeUrl(config.baseUrl)) return false;
        const res = await fetch(`${config.baseUrl}/models`);
        return res.ok;
      }
      default:
        return false;
    }
  } catch (error: any) {
    console.error(`Validation failed for ${config.provider}:`, sanitizeLog(error.message || "Unknown error"));
    return false;
  }
}
