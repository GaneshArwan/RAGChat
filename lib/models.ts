import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { AppConfig } from "./config";

export function getModelProvider(config: AppConfig) {
  switch (config.provider) {
    case "gemini":
      return createGoogleGenerativeAI({
        apiKey: config.apiKey,
      })(config.modelId);
    case "openai":
      return createOpenAI({
        apiKey: config.apiKey,
      })(config.modelId);
    case "anthropic":
      return createAnthropic({
        apiKey: config.apiKey,
      })(config.modelId);
    case "custom":
      return createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      })(config.modelId);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}
