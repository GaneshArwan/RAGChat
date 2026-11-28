import { NextResponse } from "next/server";
import { z } from "zod";
import { generateText } from "ai";
import { ConfigSchema } from "@/lib/config";
import { getModelProvider } from "@/lib/models";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, isSafeFilename, sanitizeLog } from "@/lib/validation";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { executeRetrievalPipeline, formatNumberedContext } from "@/lib/rag-pipeline";
import { computeGroundedness, recordAuditEvent, redactPii, verifyBearerToken } from "@/lib/security";
import { resolveAuthContext } from "@/lib/auth";

const EnterpriseQuerySchema = z.object({
  query: z.string().min(1).max(8000),
  activeFilenames: z.array(z.string()).optional(),
  config: ConfigSchema,
});

export async function POST(req: Request) {
  const ip = getClientIp(req);
  try {
    if (!verifyBearerToken(req)) {
      recordAuditEvent({
        action: "auth_denied",
        tenantId: "unknown",
        roles: [],
        actorIp: ip,
        details: { endpoint: "/api/v1/query" },
        status: "blocked",
      });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
    }

    const parsed = EnterpriseQuerySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request format", details: parsed.error.format() }, { status: 400 });
    }

    const { query: rawQuery, config, activeFilenames } = parsed.data;
    const auth = resolveAuthContext(req, config.tenantId, config.userRoles);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized: invalid JWT" }, { status: 401 });
    }

    if (!await rateLimit(ip, config, 30, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const tenantId = auth.tenantId;
    const userRoles = auth.roles;
    const adapter = getVectorStoreAdapter(config);

    const filenames = activeFilenames && activeFilenames.length > 0
      ? activeFilenames.filter(isSafeFilename)
      : await adapter.listDocuments(tenantId, userRoles);

    if (filenames.length === 0) {
      return NextResponse.json({ error: "No accessible documents found for tenant/roles" }, { status: 404 });
    }

    const cleanQuery = config.enablePiiRedaction ? redactPii(rawQuery).text : rawQuery;
    const rerankKey = config.rerankKeySource === "custom"
      ? (config.rerankApiKey || "")
      : config.rerankKeySource === "embedding"
      ? (config.embeddingKeySource === "custom" ? (config.embeddingApiKey || config.apiKey || "") : (config.apiKey || ""))
      : (config.apiKey || "");
    const rerankBaseUrl = config.rerankBaseUrl || config.baseUrl;

    const retrieval = await executeRetrievalPipeline({
      messages: [{ role: "user", content: cleanQuery }],
      rawQuery: cleanQuery,
      adapter,
      filenames,
      tenantId,
      userRoles,
      config,
      rerankKey,
      rerankBaseUrl,
    });

    const contextDocs = retrieval.docs;
    const formatted = formatNumberedContext(contextDocs, config.contextFormat || "toon");

    const model = getModelProvider(config);
    const { text: answer } = await generateText({
      model,
      system:
        `ROLE: Enterprise RAG API Assistant.\n` +
        `Answer ONLY from numbered Context [1]..[N] below. Cite inline with [1], [2]. ` +
        `If unsupported, reply: "I cannot find that information in the selected documents."\n\n` +
        `CONTEXT:\n${formatted}`,
      prompt: cleanQuery,
      abortSignal: AbortSignal.timeout(30000),
    });

    const sources = contextDocs.map((doc, idx) => ({
      id: idx + 1,
      filename: doc.metadata?.filename || "unknown",
      page: doc.metadata?.page || "N/A",
      section: doc.metadata?.section,
      content: doc.pageContent,
    }));

    const groundedness = computeGroundedness(answer, sources);
    const pipeline = {
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
    };

    if (config.enableAuditLog !== false) {
      recordAuditEvent({
        action: "query",
        tenantId,
        roles: userRoles,
        actorIp: ip,
        provider: config.provider,
        vectorStore: adapter.provider,
        details: {
          endpoint: "/api/v1/query",
          mode: pipeline.mode,
          hops: pipeline.hops,
          chunks: contextDocs.length,
          groundedness: groundedness.score,
          totalMs: retrieval.trace.totalMs,
        },
        status: "success",
      });
    }

    return NextResponse.json({
      answer,
      sources: sources.map(s => ({
        ...s,
        content: s.content.length > 240 ? s.content.slice(0, 240) + "..." : s.content,
      })),
      pipeline,
      groundedness,
      tenantId,
      authMode: auth.authMode,
    });
  } catch (error: any) {
    console.error("[Enterprise Query] Error:", sanitizeLog(error?.message || "Unknown error"));
    return NextResponse.json({ error: "Enterprise query failed" }, { status: 500 });
  }
}
