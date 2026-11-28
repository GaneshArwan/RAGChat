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
import { normalizeRoles, recordAuditEvent, verifyBearerToken } from "@/lib/security";
import { resolveAuthContext } from "@/lib/auth";
import { checkDeltaAndPrepare, commitContentHash } from "@/lib/jobs";
import { indexGraphFromDocs } from "@/lib/graph-rag";

const EnterpriseIngestSchema = z.object({
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
  message: "Either connector or documents array is required",
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
        details: { endpoint: "/api/v1/ingest" },
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

    const parsed = EnterpriseIngestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid ingest payload", details: parsed.error.format() }, { status: 400 });
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
    const adapter = getVectorStoreAdapter(config);
    const allChunks: Document[] = [];
    const indexedFiles: string[] = [];
    const unchangedFiles: string[] = [];
    const pendingHashes: Array<{ filename: string; hash: string }> = [];
    let totalRedactions = 0;

    if (connector) {
      const synced = await runConnector(connector);
      for (const item of synced) {
        const delta = await checkDeltaAndPrepare(tenantId, item.sourceName, item.content, adapter);
        if (!delta.changed) {
          unchangedFiles.push(item.sourceName);
          indexedFiles.push(item.sourceName);
          continue;
        }
        const { chunks, redactions } = await chunkDocumentsWithContext(
          [new Document({ pageContent: item.content, metadata: item.metadata })],
          item.sourceName,
          { tenantId, allowedRoles: roles, enablePiiRedaction: !!config.enablePiiRedaction, sourceType: connector.type }
        );
        totalRedactions += redactions;
        if (chunks.length > 0) {
          allChunks.push(...chunks);
          indexedFiles.push(item.sourceName);
          pendingHashes.push({ filename: item.sourceName, hash: delta.hash });
        }
      }
    }

    if (documents) {
      for (const d of documents) {
        if (!isSafeFilename(d.filename)) continue;
        const delta = await checkDeltaAndPrepare(tenantId, d.filename, d.content, adapter);
        if (!delta.changed) {
          unchangedFiles.push(d.filename);
          indexedFiles.push(d.filename);
          continue;
        }
        const { chunks, redactions } = await chunkDocumentsWithContext(
          [new Document({ pageContent: d.content, metadata: { pageNumber: d.page || 1, section: d.section } })],
          d.filename,
          { tenantId, allowedRoles: roles, enablePiiRedaction: !!config.enablePiiRedaction, sourceType: "api" }
        );
        totalRedactions += redactions;
        if (chunks.length > 0) {
          allChunks.push(...chunks);
          indexedFiles.push(d.filename);
          pendingHashes.push({ filename: d.filename, hash: delta.hash });
        }
      }
    }

    if (allChunks.length === 0 && unchangedFiles.length === 0) {
      return NextResponse.json({ error: "No valid chunks produced" }, { status: 400 });
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
        details: { endpoint: "/api/v1/ingest", files: indexedFiles.length, unchanged: unchangedFiles.length, chunks: allChunks.length, redactions: totalRedactions },
        status: "success",
      });
    }

    return NextResponse.json({
      message: "Enterprise ingest completed",
      tenantId,
      indexedFiles,
      unchangedFiles,
      chunkCount: allChunks.length,
      redactions: totalRedactions,
    });
  } catch (error: any) {
    console.error("[Enterprise Ingest] Error:", sanitizeLog(error?.message || "Unknown error"));
    return NextResponse.json({ error: "Enterprise ingest failed" }, { status: 500 });
  }
}
