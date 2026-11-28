import { NextResponse } from "next/server";
import { ConfigSchema } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { sanitizeLog, isSafeFilename, getClientIp } from "@/lib/validation";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { normalizeRoles, recordAuditEvent } from "@/lib/security";
import { resolveAuthContext } from "@/lib/auth";
import { clearContentHash } from "@/lib/jobs";

/**
 * DOCUMENT MANAGEMENT API
 * Supports tenant-isolated, RBAC-scoped listing and deleting of indexed documents.
 */

export async function GET(req: Request) {
  try {
    const ip = getClientIp(req);
    if (!await rateLimit(ip, undefined, 30, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const { searchParams } = new URL(req.url);
    const auth = resolveAuthContext(
      req,
      searchParams.get("tenantId") || "default",
      searchParams.get("roles") || "member"
    );
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const tenantId = auth.tenantId;
    const userRoles = auth.roles;
    const vectorStoreProvider = (searchParams.get("vectorStoreProvider") || "chroma") as "chroma" | "qdrant" | "pinecone";
    const vectorStoreUrl = searchParams.get("vectorStoreUrl") || undefined;
    const vectorStoreApiKey = req.headers.get("x-vector-store-key") || undefined;
    const vectorStoreIndex = searchParams.get("vectorStoreIndex") || undefined;

    if (vectorStoreProvider === "qdrant" && !vectorStoreUrl && !process.env.QDRANT_URL) {
      return NextResponse.json({ documents: [] });
    }
    if (vectorStoreProvider === "pinecone" && ((!vectorStoreUrl && !process.env.PINECONE_INDEX_HOST) || (!vectorStoreApiKey && !process.env.PINECONE_API_KEY))) {
      return NextResponse.json({ documents: [] });
    }

    const adapter = getVectorStoreAdapter({
      vectorStoreProvider,
      vectorStoreUrl,
      vectorStoreApiKey,
      vectorStoreIndex,
    });
    const documents = await adapter.listDocuments(tenantId, userRoles);
    return NextResponse.json({ documents });
  } catch (error: any) {
    console.error("[Documents] List error:", sanitizeLog(error.message || "Unknown error"));
    return NextResponse.json({ error: "Failed to list documents" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
    }

    const { filename, config } = body;

    if (!filename) {
      return NextResponse.json({ error: "Filename is required" }, { status: 400 });
    }

    if (!isSafeFilename(filename)) {
      return NextResponse.json({ error: "Invalid filename format" }, { status: 400 });
    }

    const parsedConfig = config && config.provider ? ConfigSchema.safeParse(config) : null;
    const validConfig = parsedConfig?.success ? parsedConfig.data : undefined;

    const ip = getClientIp(req);
    if (!await rateLimit(ip, validConfig, 10, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const auth = resolveAuthContext(
      req,
      validConfig?.tenantId || config?.tenantId || "default",
      validConfig?.userRoles
    );
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const tenantId = auth.tenantId;
    const adapter = getVectorStoreAdapter(validConfig || {
      vectorStoreProvider: config?.vectorStoreProvider || "chroma",
      vectorStoreUrl: config?.vectorStoreUrl,
      vectorStoreApiKey: config?.vectorStoreApiKey,
      vectorStoreIndex: config?.vectorStoreIndex,
    });
    await adapter.deleteByFilename(filename, tenantId);
    clearContentHash(tenantId, filename);

    if (validConfig?.enableAuditLog !== false) {
      recordAuditEvent({
        action: "delete",
        tenantId,
        roles: normalizeRoles(validConfig?.userRoles),
        actorIp: ip,
        vectorStore: adapter.provider,
        details: { filename },
        status: "success",
      });
    }

    return NextResponse.json({ message: `Successfully deleted ${filename}` });
  } catch (error: any) {
    console.error("[Documents] Delete error:", sanitizeLog(error.message || "Unknown error"));
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
}
