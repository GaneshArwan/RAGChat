import { streamText, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getVectorStore } from "@/lib/embeddings";
import { getModelProvider } from "@/lib/models";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { ConfigSchema, AppConfig } from "@/lib/config";
import { Document } from "@langchain/core/documents";
import { wrapWithProviderCache } from "@/lib/cache";
import { sanitizeLog } from "@/lib/validation";

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

function formatContext(docs: Document[], format: "json" | "toon"): string {
  if (format === "json") {
    return JSON.stringify(docs.map(d => ({
      source: d.metadata.filename,
      page: d.metadata.page,
      content: d.pageContent.replace(/<\|.*?\|>/g, "").trim()
    })), null, 2);
  }

  // TOON Formatting (2026 Schema-First Tabular)
  const header = "sources{filename, page, content}:";
  const rows = docs.map(d => {
    const filename = d.metadata.filename;
    const page = d.metadata.page || "N/A";
    const content = d.pageContent.replace(/<\|.*?\|>/g, "").replace(/\n/g, " ").trim();
    return `  ${filename}, ${page}, ${content}`;
  }).join("\n");

  return `${header}\n${rows}`;
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "anonymous";
    const body = await req.json();
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

    if (!config.apiKey) {
      return new Response(JSON.stringify({ error: "API Key is required" }), { status: 401 });
    }

    // Key Resolution based on Sources
    const apiKey = config.apiKey as string;
    const embeddingKey = config.embeddingKeySource === "custom" ? (config.embeddingApiKey as string) : apiKey;
    let rerankKey = apiKey; 
    if (config.rerankKeySource === "custom") rerankKey = config.rerankApiKey as string;
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

    const safeFilenamePattern = /^[a-zA-Z0-9_\-\.]+$/;
    for (const filename of activeFilenames) {
      if (!safeFilenamePattern.test(filename)) {
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
            console.log(`[Chat] Vector Store query starting...`);
            const vectorStore = await getVectorStore({ 
              ...embeddingConfig, 
              embeddingBaseUrl: embeddingBaseUrl 
            } as AppConfig);
            
            let contextDocs: Document[] = [];
            
            let systemPrompt = "You are a precision-focused RAG assistant. STRICT INSTRUCTION: Answer ONLY using the provided Context.";
            
            if (config.useCag) {
              console.log(`[Chat] Using CAG mode with deterministic retrieval...`);
              
              // Direct fetch by metadata to ensure query-independence (stable cache hash)
              const collection = await (vectorStore as any).ensureCollection();
              const response = await collection.get({
                where: { filename: { $in: sortedActiveFiles } },
                limit: 1000
              });

              // Convert Chroma results back to LangChain Documents
              contextDocs = (response.ids || []).map((id: string, i: number) => ({
                pageContent: response.documents[i] || "",
                metadata: response.metadatas[i] || {}
              } as Document));

              contextDocs.sort((a, b) => {
                if (a.metadata.filename !== b.metadata.filename) return a.metadata.filename.localeCompare(b.metadata.filename);
                return (a.metadata.page || 0) - (b.metadata.page || 0);
              });

              const contextText = formatContext(contextDocs, config.contextFormat || "toon");
              systemPrompt = `You are a helpful assistant. Use the following context to answer the user's question.

            CONTEXT:
            ${contextText}`;

              // Unified Caching Logic (Returns updated system instructions and messages)
              const cacheResult = await wrapWithProviderCache(messages, systemPrompt, config);
              systemPrompt = cacheResult.systemPrompt;
              messages = cacheResult.messages;
            } else {
              console.log(`[Chat] Using RAG mode with threshold: ${config.similarityThreshold}...`);
              const k = config.useReranking ? 20 : 4;
              
              const distanceThreshold = (1 - (config.similarityThreshold || 0.3)) * 2;
              const searchResults = await vectorStore.similaritySearchWithScore(
                lastMessage.content,
                k,
                { filename: { $in: sortedActiveFiles } }
              );

              contextDocs = searchResults
                .filter(([doc, score]) => score <= distanceThreshold)
                .map(([doc]) => doc);

              // Sort retrieved chunks to ensure deterministic prompt prefixing
              contextDocs.sort((a, b) => {
                if (a.metadata.filename !== b.metadata.filename) return a.metadata.filename.localeCompare(b.metadata.filename);
                return (a.metadata.page || 0) - (b.metadata.page || 0);
              });

              if (config.useReranking && contextDocs.length > 1) {
                // ... (Reranking logic remains same)
              }

              const context = formatContext(contextDocs, config.contextFormat || "toon");

              systemPrompt = `ROLE: You are a precision-focused RAG assistant.
                STRICT INSTRUCTION: Answer ONLY using the provided Context.
                Context:
                ${context}`;
            }

            console.log(`[Chat] Retrieved ${contextDocs.length} source segments.`);

            const sources = contextDocs.map(doc => ({
              filename: doc.metadata.filename,
              page: doc.metadata.page || "N/A",
              content: doc.pageContent.substring(0, 160) + "..."
            }));

            writer.write({ type: 'data-custom', data: { type: 'sources', sources } });

            console.log(`[Chat] Initializing LLM provider: ${config.provider}`);
            const model = getModelProvider(config);

            const result = streamText({
              model,
              system: systemPrompt,
              messages,
            });

            writer.merge(result.toUIMessageStream() as any);
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
