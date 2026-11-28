import { streamText, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getModelProvider } from "@/lib/models";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { ConfigSchema, AppConfig } from "@/lib/config";
import { Document } from "@langchain/core/documents";
import { wrapWithProviderCache } from "@/lib/cache";
import { sanitizeLog, isSafeFilename, getClientIp } from "@/lib/validation";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { computeGroundedness, recordAuditEvent, redactPii } from "@/lib/security";
import { resolveAuthContext } from "@/lib/auth";
import {
  dedupeDocs,
  sortDocsDeterministically,
  formatNumberedContext,
  executeRetrievalPipeline,
} from "@/lib/rag-pipeline";

const MessagePartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  data: z.any().optional(),
  reasoning: z.string().optional(),
}).passthrough();

const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().optional(),
  parts: z.array(MessagePartSchema).optional(),
});

const ChatSchema = z.object({
  messages: z.array(MessageSchema).optional(),
  prompt: z.string().optional(),
  config: ConfigSchema,
  activeFilenames: z.array(z.string()).optional(),
});

function extractContent(message: z.infer<typeof MessageSchema>): string {
  if (message.content) return message.content;
  if (message.parts && message.parts.length > 0) {
    return message.parts
      .filter(part => part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("");
  }
  return "";
}

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid request JSON" }), { status: 400 });
    }
    const validationResult = ChatSchema.safeParse(body);
    if (!validationResult.success) {
      console.error("[Chat] Validation Error:", validationResult.error.format());
      return new Response(JSON.stringify({ error: "Invalid request format" }), { status: 400 });
    }
    
    const { messages: schemaMessages, config, activeFilenames } = validationResult.data;

    // Distributed Rate Limiting (checks Redis if configured in UI)
    if (!await rateLimit(ip, config, 20, 60000)) {
      return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
    }

    if (config.provider === "custom") {
      if (!config.baseUrl) {
        return new Response(JSON.stringify({ error: "Base URL is required for custom provider" }), { status: 400 });
      }
    } else if (!config.apiKey) {
      return new Response(JSON.stringify({ error: "API Key is required" }), { status: 401 });
    }

    // Key Resolution based on Sources
    const apiKey = (config.apiKey || "") as string;
    const embeddingKey = config.embeddingKeySource === "custom" ? (config.embeddingApiKey || apiKey) : apiKey;
    let rerankKey = apiKey; 
    if (config.rerankKeySource === "custom") rerankKey = config.rerankApiKey || "";
    else if (config.rerankKeySource === "embedding") rerankKey = embeddingKey;

    const embeddingConfig = { ...config, apiKey: embeddingKey };
    
    // Base URL Inheritance
    const embeddingBaseUrl = config.embeddingBaseUrl || config.baseUrl;
    const rerankBaseUrl = config.rerankBaseUrl || config.baseUrl;

    let messages: any[] = [];
    if (schemaMessages && schemaMessages.length > 0) {
      messages = schemaMessages.map(m => ({
        role: m.role,
        content: extractContent(m)
      }));
    } else if (validationResult.data.prompt) {
      messages = [{ role: "user", content: validationResult.data.prompt }];
    }

    if (messages.length === 0 || !messages[messages.length - 1].content) {
      return new Response(JSON.stringify({ error: "No messages provided" }), { status: 400 });
    }

    if (!activeFilenames || activeFilenames.length === 0) {
      return new Response(JSON.stringify({ error: "No active documents selected for context." }), { status: 400 });
    }

    for (const filename of activeFilenames) {
      if (!isSafeFilename(filename)) {
        return new Response(JSON.stringify({ error: "Invalid active document name format" }), { status: 400 });
      }
    }

    // Deterministic Sort to maximize Cache Hit Rate (UCO)
    const sortedActiveFiles = [...activeFilenames].sort((a, b) => a.localeCompare(b));

    console.log(`[Chat] Incoming: provider=${config.provider}, model=${config.modelId}, activeFiles=${sortedActiveFiles.length}`);

    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: async ({ writer }) => {
          try {
            const lastMessage = messages[messages.length - 1];
            const auth = resolveAuthContext(req, config.tenantId, config.userRoles);
            if (!auth) {
              writer.write({ type: 'error', errorText: "Unauthorized: invalid or missing JWT" });
              return;
            }
            const tenantId = auth.tenantId;
            const userRoles = auth.roles;
            const rawQuery = config.enablePiiRedaction ? redactPii(lastMessage.content).text : lastMessage.content;
            if (config.enablePiiRedaction) {
              messages = messages.map((m, idx) =>
                idx === messages.length - 1 ? { ...m, content: rawQuery } : m
              );
            }

            console.log(`[Chat] Vector Store (${config.vectorStoreProvider || "chroma"}) query starting for tenant=${tenantId} (${auth.authMode})...`);
            const adapter = getVectorStoreAdapter({
              ...embeddingConfig,
              embeddingBaseUrl,
            } as AppConfig);

            let contextDocs: Document[] = [];
            let pipelineTelemetry: Record<string, any> = {
              mode: "DENSE",
              rewrittenQuery: rawQuery,
              wasRewritten: false,
              denseHits: 0,
              bm25Hits: 0,
              reranked: false,
              hops: 1,
              finalCount: 0,
              tenantId,
              vectorStore: adapter.provider,
              authMode: auth.authMode,
            };

            const groundingPrompt = (ctx: string) =>
              `ROLE: You are a precision-focused RAG assistant.\n` +
              `STRICT GROUNDING RULES:\n` +
              `1. Answer ONLY using the numbered Context passages [1]..[N] below.\n` +
              `2. Cite supporting sources inline using bracketed numbers like [1] or [1][2] right after each claim.\n` +
              `3. If the answer cannot be verified from the Context, state explicitly: "I cannot find that information in the selected documents."\n\n` +
              `CONTEXT:\n${ctx}`;

            let systemPrompt = groundingPrompt("");

            if (config.useCag) {
              console.log(`[Chat] Using CAG mode with deterministic retrieval...`);
              contextDocs = await adapter.getAllByFilenames(sortedActiveFiles, tenantId, userRoles, 1000);
              contextDocs = sortDocsDeterministically(dedupeDocs(contextDocs));

              const contextText = formatNumberedContext(contextDocs, config.contextFormat || "toon");
              systemPrompt = groundingPrompt(contextText);

              // Unified Caching Logic (Returns updated system instructions and messages)
              const cacheResult = await wrapWithProviderCache(messages, systemPrompt, config);
              systemPrompt = cacheResult.systemPrompt;
              messages = cacheResult.messages;

              pipelineTelemetry = {
                mode: "CAG",
                rewrittenQuery: rawQuery,
                wasRewritten: false,
                denseHits: contextDocs.length,
                bm25Hits: 0,
                reranked: false,
                hops: 1,
                finalCount: contextDocs.length,
                tenantId,
                vectorStore: adapter.provider,
                authMode: auth.authMode,
              };
            } else {
              const retrieval = await executeRetrievalPipeline({
                messages,
                rawQuery,
                adapter,
                filenames: sortedActiveFiles,
                tenantId,
                userRoles,
                config,
                rerankKey,
                rerankBaseUrl,
              });

              contextDocs = retrieval.docs;
              const context = formatNumberedContext(contextDocs, config.contextFormat || "toon");
              systemPrompt = groundingPrompt(context);

              pipelineTelemetry = {
                mode: retrieval.mode,
                rewrittenQuery: retrieval.rewrittenQuery,
                wasRewritten: retrieval.wasRewritten,
                denseHits: retrieval.denseHits,
                bm25Hits: retrieval.bm25Hits,
                graphHits: retrieval.graphHits,
                reranked: retrieval.reranked,
                hops: retrieval.hops,
                subQueries: retrieval.subQueries,
                trace: retrieval.trace,
                finalCount: contextDocs.length,
                tenantId,
                vectorStore: adapter.provider,
                authMode: auth.authMode,
              };
            }

            console.log(`[Chat] Retrieved ${contextDocs.length} source segments (${pipelineTelemetry.mode}).`);

            const fullSources = contextDocs.map((doc, idx) => ({
              id: idx + 1,
              filename: doc.metadata.filename,
              page: doc.metadata.page || "N/A",
              section: doc.metadata.section || undefined,
              content: doc.pageContent,
            }));

            const sources = fullSources.map(s => ({
              ...s,
              content: s.content.length > 160 ? s.content.substring(0, 160) + "..." : s.content,
            }));

            writer.write({ type: 'data-custom', data: { type: 'pipeline', pipeline: pipelineTelemetry } });
            writer.write({ type: 'data-custom', data: { type: 'sources', sources } });

            console.log(`[Chat] Initializing LLM provider: ${config.provider}`);
            const model = getModelProvider(config);

            const result = streamText({
              model,
              system: systemPrompt,
              messages,
              onFinish: ({ text }) => {
                const groundedness = computeGroundedness(text, fullSources);
                writer.write({ type: 'data-custom', data: { type: 'groundedness', groundedness } });
                if (config.enableAuditLog !== false) {
                  recordAuditEvent({
                    action: "query",
                    tenantId,
                    roles: userRoles,
                    actorIp: ip,
                    provider: config.provider,
                    vectorStore: adapter.provider,
                    details: {
                      mode: pipelineTelemetry.mode,
                      chunks: contextDocs.length,
                      groundedness: groundedness.score,
                    },
                    status: "success",
                  });
                }
              },
            });

            writer.merge(result.toUIMessageStream() as any);
            await result.text;
          } catch (innerError: any) {
            const cleanMessage = sanitizeLog(innerError.message || "Internal generation error");
            console.error("[Chat] Stream execution error:", cleanMessage);
            writer.write({ type: 'error', errorText: cleanMessage });
          }
        }
      })
    });
  } catch (error: any) {
    console.error("[Chat] Route error:", sanitizeLog(error.message || "Unknown error"));
    return new Response(JSON.stringify({ error: "An error occurred" }), { status: 500 });
  }
}
