import { NextResponse } from "next/server";
import { z } from "zod";
import { Document } from "@langchain/core/documents";
import { ConfigSchema } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, sanitizeLog } from "@/lib/validation";
import { ConnectorPayloadSchema } from "@/lib/connectors/types";
import { getConnectorCatalog, runConnector } from "@/lib/connectors/registry";
import { chunkDocumentsWithContext } from "@/lib/chunking";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { normalizeRoles, recordAuditEvent } from "@/lib/security";
import { resolveAuthContext } from "@/lib/auth";
import { checkDeltaAndPrepare, commitContentHash } from "@/lib/jobs";
import { indexGraphFromDocs } from "@/lib/graph-rag";

const ConnectorSyncSchema = z.object({
  connector: ConnectorPayloadSchema,
  config: ConfigSchema,
  allowedRoles: z.array(z.string().max(64)).optional(),
});

export async function GET(req: Request) {
  const ip = getClientIp(req);
  if (!await rateLimit(ip, undefined, 60, 60000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  return NextResponse.json({ connectors: getConnectorCatalog() });
}

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
    }

    const parsed = ConnectorSyncSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid connector request", details: parsed.error.format() }, { status: 400 });
    }

    const { connector, config, allowedRoles } = parsed.data;
    const auth = resolveAuthContext(req, config.tenantId, config.userRoles);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!await rateLimit(ip, config, 10, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const rawDocs = await runConnector(connector);
    const tenantId = auth.tenantId;
    const roles = allowedRoles ? normalizeRoles(allowedRoles) : auth.roles;
    const adapter = getVectorStoreAdapter(config);

    const allChunks: Document[] = [];
    const indexedFiles: string[] = [];
    const unchangedFiles: string[] = [];
    const pendingHashes: Array<{ filename: string; hash: string }> = [];
    let totalRedactions = 0;

    for (const item of rawDocs) {
      const delta = await checkDeltaAndPrepare(tenantId, item.sourceName, item.content, adapter);
      if (!delta.changed) {
        unchangedFiles.push(item.sourceName);
        indexedFiles.push(item.sourceName);
        continue;
      }

      const lcDoc = new Document({
        pageContent: item.content,
        metadata: item.metadata,
      });
      const { chunks, redactions } = await chunkDocumentsWithContext([lcDoc], item.sourceName, {
        tenantId,
        allowedRoles: roles,
        enablePiiRedaction: !!config.enablePiiRedaction,
        sourceType: connector.type,
      });
      totalRedactions += redactions;
      if (chunks.length > 0) {
        allChunks.push(...chunks);
        indexedFiles.push(item.sourceName);
        pendingHashes.push({ filename: item.sourceName, hash: delta.hash });
      }
    }

    if (allChunks.length === 0 && unchangedFiles.length === 0) {
      return NextResponse.json({ error: "Connector returned no indexable chunks" }, { status: 400 });
    }

    if (allChunks.length > 0) {
      await adapter.indexDocuments(allChunks);
      indexGraphFromDocs(allChunks, tenantId);
      pendingHashes.forEach(p => commitContentHash(tenantId, p.filename, p.hash));
    }

    if (config.enableAuditLog !== false) {
      recordAuditEvent({
        action: "connector_sync",
        tenantId,
        roles,
        actorIp: ip,
        vectorStore: adapter.provider,
        details: {
          connector: connector.type,
          files: indexedFiles.length,
          unchanged: unchangedFiles.length,
          chunks: allChunks.length,
          redactions: totalRedactions,
        },
        status: "success",
      });
    }

    return NextResponse.json({
      message: `Synced ${indexedFiles.length} document(s) from ${connector.type}`,
      indexedFiles,
      unchangedFiles,
      chunkCount: allChunks.length,
      redactions: totalRedactions,
    });
  } catch (error: any) {
    console.error("[Connectors] Sync error:", sanitizeLog(error?.message || "Unknown error"));
    return NextResponse.json({ error: sanitizeLog(error?.message || "Connector sync failed") }, { status: 500 });
  }
}
