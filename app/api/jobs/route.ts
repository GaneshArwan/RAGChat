import { NextResponse } from "next/server";
import { z } from "zod";
import { Document } from "@langchain/core/documents";
import { ConfigSchema } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, isSafeFilename, sanitizeLog } from "@/lib/validation";
import { ConnectorPayloadSchema } from "@/lib/connectors/types";
import { runConnector } from "@/lib/connectors/registry";
import { chunkDocumentsWithContext } from "@/lib/chunking";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { normalizeRoles, recordAuditEvent } from "@/lib/security";
import { resolveAuthContext } from "@/lib/auth";
import { checkDeltaAndPrepare, commitContentHash, enqueueIngestJob, getJob, listJobs } from "@/lib/jobs";
import { indexGraphFromDocs } from "@/lib/graph-rag";

const JobCreateSchema = z.object({
  config: ConfigSchema,
  allowedRoles: z.array(z.string().max(64)).optional(),
  connector: ConnectorPayloadSchema.optional(),
  documents: z.array(z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1).max(500_000),
    page: z.number().int().min(1).optional(),
    section: z.string().optional(),
  })).max(50).optional(),
}).refine(d => Boolean(d.connector || (d.documents && d.documents.length > 0)), {
  message: "Either connector or documents is required",
});

export async function GET(req: Request) {
  const ip = getClientIp(req);
  if (!await rateLimit(ip, undefined, 60, 60000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const tenantParam = searchParams.get("tenantId") || undefined;

  const auth = resolveAuthContext(req, tenantParam, undefined);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (id) {
    const job = getJob(id);
    if (!job || (auth.authMode === "jwt-verified" && job.tenantId !== auth.tenantId)) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({ job });
  }

  const filterTenant = auth.authMode === "jwt-verified" ? auth.tenantId : tenantParam;
  return NextResponse.json({ jobs: listJobs(filterTenant, 50) });
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
    }

    const parsed = JobCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid job payload", details: parsed.error.format() }, { status: 400 });
    }

    const { config, allowedRoles, connector, documents } = parsed.data;
    const auth = resolveAuthContext(req, config.tenantId, config.userRoles);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!await rateLimit(ip, config, 15, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const tenantId = auth.tenantId;
    const roles = allowedRoles ? normalizeRoles(allowedRoles) : auth.roles;
    const sourceLabel = connector ? connector.type : "api_batch";

    const job = enqueueIngestJob(tenantId, sourceLabel, async () => {
      const adapter = getVectorStoreAdapter(config);
      const allChunks: Document[] = [];
      const indexedFiles: string[] = [];
      const skippedUnchanged: string[] = [];
      const pendingHashes: Array<{ filename: string; hash: string }> = [];
      let totalRedactions = 0;

      const processItem = async (filename: string, content: string, meta: Record<string, any>, sourceType: string) => {
        const delta = await checkDeltaAndPrepare(tenantId, filename, content, adapter);
        if (!delta.changed) {
          skippedUnchanged.push(filename);
          indexedFiles.push(filename);
          return;
        }
        const { chunks, redactions } = await chunkDocumentsWithContext(
          [new Document({ pageContent: content, metadata: meta })],
          filename,
          { tenantId, allowedRoles: roles, enablePiiRedaction: !!config.enablePiiRedaction, sourceType }
        );
        totalRedactions += redactions;
        if (chunks.length > 0) {
          allChunks.push(...chunks);
          indexedFiles.push(filename);
          pendingHashes.push({ filename, hash: delta.hash });
        }
      };

      if (connector) {
        const synced = await runConnector(connector);
        for (const item of synced) {
          await processItem(item.sourceName, item.content, item.metadata, connector.type);
        }
      }

      if (documents) {
        for (const d of documents) {
          if (!isSafeFilename(d.filename)) continue;
          await processItem(d.filename, d.content, { pageNumber: d.page || 1, section: d.section }, "api");
        }
      }

      if (allChunks.length > 0) {
        await adapter.indexDocuments(allChunks);
        indexGraphFromDocs(allChunks, tenantId);
        pendingHashes.forEach(p => commitContentHash(tenantId, p.filename, p.hash));
      }

      if (config.enableAuditLog !== false) {
        recordAuditEvent({
          action: "ingest",
          tenantId,
          roles,
          actorIp: ip,
          vectorStore: adapter.provider,
          details: { source: sourceLabel, asyncJob: true, files: indexedFiles.length, unchanged: skippedUnchanged.length, chunks: allChunks.length },
          status: "success",
        });
      }

      return { indexedFiles, skippedUnchanged, chunkCount: allChunks.length, redactions: totalRedactions };
    });

    return NextResponse.json({ message: "Ingestion job queued", jobId: job.id, job }, { status: 202 });
  } catch (error: any) {
    console.error("[Jobs] Create error:", sanitizeLog(error?.message || "Unknown error"));
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}
