import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Document } from "@langchain/core/documents";
import { ConfigSchema } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, isSafeFilename, sanitizeLog } from "@/lib/validation";
import { chunkDocumentsWithContext } from "@/lib/chunking";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { indexGraphFromDocs } from "@/lib/graph-rag";
import { checkDeltaAndPrepare, commitContentHash, enqueueIngestJob } from "@/lib/jobs";
import { recordAuditEvent } from "@/lib/security";

const ALLOWED_PROVIDERS = new Set(["github", "jira", "slack", "generic"]);

function timingSafeMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyWebhookSignature(
  req: Request,
  rawBody: string,
  provider: string
): { valid: boolean; reason?: string } {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return { valid: false, reason: "WEBHOOK_SECRET is not configured" };
    }
    // Check shared secret header in non-production only if caller sent one
    const provided = req.headers.get("x-webhook-secret");
    if (provided) {
      return { valid: false, reason: "Unexpected secret header when WEBHOOK_SECRET unset" };
    }
    return { valid: true };
  }

  const directSecret = req.headers.get("x-webhook-secret");
  if (directSecret && timingSafeMatch(secret, directSecret)) {
    return { valid: true };
  }

  if (provider === "slack") {
    const slackSig = req.headers.get("x-slack-signature") || "";
    const ts = req.headers.get("x-slack-request-timestamp") || "";
    const expected = `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
    if (slackSig && ts && timingSafeMatch(expected, slackSig)) {
      return { valid: true };
    }
  }

  const hmacHeader =
    req.headers.get("x-hub-signature-256") ||
    req.headers.get("x-ragchat-signature") ||
    "";
  if (hmacHeader) {
    const cleanActual = hmacHeader.startsWith("sha256=") ? hmacHeader.slice(7) : hmacHeader;
    const expectedHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (timingSafeMatch(expectedHex, cleanActual)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: "Invalid webhook signature" };
}

function extractWebhookDocs(
  provider: string,
  payload: Record<string, any>
): Array<{ filename: string; content: string; section?: string }> {
  const docs: Array<{ filename: string; content: string; section?: string }> = [];

  if (Array.isArray(payload.documents)) {
    for (const d of payload.documents.slice(0, 50)) {
      if (typeof d?.filename === "string" && typeof d?.content === "string" && isSafeFilename(d.filename)) {
        docs.push({ filename: d.filename, content: d.content, section: d.section });
      }
    }
  }

  if (provider === "github" && payload.repository?.full_name) {
    const repo = String(payload.repository.full_name).replace(/[^a-zA-Z0-9._-]/g, "_");
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const lines = commits.slice(0, 20).map((c: any) => {
      const files = [...(c.added || []), ...(c.modified || [])].join(", ");
      return `- ${String(c.id || "").slice(0, 8)}: ${c.message || ""} [files: ${files}]`;
    });
    if (lines.length > 0) {
      docs.push({
        filename: `webhook-github-${repo}.md`,
        content: `# GitHub Push (${payload.repository.full_name})\n\n${lines.join("\n")}`,
        section: "Webhook Push Event",
      });
    }
  }

  if (provider === "jira" && payload.issue?.key) {
    const key = String(payload.issue.key).replace(/[^a-zA-Z0-9._-]/g, "_");
    const summary = payload.issue.fields?.summary || "";
    const description = payload.issue.fields?.description || "";
    docs.push({
      filename: `webhook-jira-${key}.md`,
      content: `# Jira ${key}: ${summary}\n\n${typeof description === "string" ? description : JSON.stringify(description)}`,
      section: "Jira Webhook",
    });
  }

  if (provider === "slack" && payload.event?.text) {
    const channel = String(payload.event.channel || "general").replace(/[^a-zA-Z0-9._-]/g, "_");
    docs.push({
      filename: `webhook-slack-${channel}.md`,
      content: `# Slack Channel ${channel}\n\n${String(payload.event.text)}`,
      section: "Slack Event",
    });
  }

  return docs;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ provider: string }> }
) {
  const ip = getClientIp(req);
  const { provider: rawProvider } = await context.params;
  const provider = (rawProvider || "generic").toLowerCase();

  if (!ALLOWED_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Unsupported webhook provider" }, { status: 400 });
  }

  if (!await rateLimit(ip, undefined, 30, 60000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const rawBody = await req.text();
  if (!rawBody || rawBody.length > 2_000_000) {
    return NextResponse.json({ error: "Invalid or oversized webhook payload" }, { status: 400 });
  }

  const authCheck = verifyWebhookSignature(req, rawBody, provider);
  if (!authCheck.valid) {
    recordAuditEvent({
      action: "auth_denied",
      tenantId: "webhook",
      roles: [],
      actorIp: ip,
      details: { endpoint: `/api/webhooks/${provider}`, reason: authCheck.reason || "unauthorized" },
      status: "blocked",
    });
    return NextResponse.json({ error: authCheck.reason || "Unauthorized webhook" }, { status: 401 });
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed webhook JSON" }, { status: 400 });
  }

  if (provider === "slack" && payload.type === "url_verification" && typeof payload.challenge === "string") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const tenantId = String(payload.tenantId || payload.config?.tenantId || "default")
    .replace(/[^a-zA-Z0-9_-]/g, "") || "default";

  const parsedConfig = ConfigSchema.safeParse(payload.config || {
    provider: process.env.OPENAI_API_KEY ? "openai" : "gemini",
    apiKey: process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY || "",
    model: process.env.OPENAI_API_KEY ? "gpt-4o-mini" : "gemini-2.5-flash",
    tenantId,
  });

  if (!parsedConfig.success) {
    return NextResponse.json({ error: "Invalid webhook RAG config", details: parsedConfig.error.format() }, { status: 400 });
  }

  const docsToSync = extractWebhookDocs(provider, payload);
  if (docsToSync.length === 0) {
    return NextResponse.json({ accepted: true, queued: false, message: "No indexable webhook content" });
  }

  const config = parsedConfig.data;
  const job = enqueueIngestJob(tenantId, `webhook:${provider}`, async () => {
    const adapter = getVectorStoreAdapter(config);
    const allChunks: Document[] = [];
    const indexedFiles: string[] = [];
    const skippedUnchanged: string[] = [];
    const pendingHashes: Array<{ filename: string; hash: string }> = [];
    let totalRedactions = 0;

    for (const item of docsToSync) {
      const delta = await checkDeltaAndPrepare(tenantId, item.filename, item.content, adapter);
      if (!delta.changed) {
        skippedUnchanged.push(item.filename);
        continue;
      }
      const { chunks, redactions } = await chunkDocumentsWithContext(
        [new Document({ pageContent: item.content, metadata: { pageNumber: 1, section: item.section } })],
        item.filename,
        { tenantId, allowedRoles: config.userRoles || ["member"], enablePiiRedaction: !!config.enablePiiRedaction, sourceType: `webhook:${provider}` }
      );
      totalRedactions += redactions;
      if (chunks.length > 0) {
        allChunks.push(...chunks);
        indexedFiles.push(item.filename);
        pendingHashes.push({ filename: item.filename, hash: delta.hash });
      }
    }

    if (allChunks.length > 0) {
      await adapter.indexDocuments(allChunks);
      indexGraphFromDocs(allChunks, tenantId);
      pendingHashes.forEach((p) => commitContentHash(tenantId, p.filename, p.hash));
    }

    recordAuditEvent({
      action: "ingest",
      tenantId,
      roles: config.userRoles || ["member"],
      actorIp: ip,
      vectorStore: adapter.provider,
      details: { webhookProvider: provider, files: indexedFiles.length, unchanged: skippedUnchanged.length, chunks: allChunks.length, redactions: totalRedactions },
      status: "success",
    });

    return { indexedFiles, skippedUnchanged, chunkCount: allChunks.length, redactions: totalRedactions };
  });

  console.log(`[Webhook:${sanitizeLog(provider)}] Queued sync job ${job.id} for tenant=${sanitizeLog(tenantId)}`);
  return NextResponse.json({ accepted: true, queued: true, provider, jobId: job.id }, { status: 202 });
}
