import { NextResponse } from "next/server";
import { z } from "zod";
import { ConfigSchema } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp, isSafeFilename, sanitizeLog } from "@/lib/validation";
import { resolveAuthContext } from "@/lib/auth";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { evaluateRagCases } from "@/lib/eval";
import { recordAuditEvent } from "@/lib/security";

const EvalRequestSchema = z.object({
  config: ConfigSchema,
  activeFilenames: z.array(z.string()).optional(),
  cases: z.array(z.object({
    question: z.string().min(1).max(2000),
    expectedKeywords: z.array(z.string().max(100)).max(15).optional(),
    expectedFilename: z.string().max(255).optional(),
  })).min(1).max(10),
});

export async function POST(req: Request) {
  const ip = getClientIp(req);
  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
    }

    const parsed = EvalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid evaluation payload", details: parsed.error.format() }, { status: 400 });
    }

    const { config, activeFilenames, cases } = parsed.data;
    const auth = resolveAuthContext(req, config.tenantId, config.userRoles);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!await rateLimit(ip, config, 10, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const adapter = getVectorStoreAdapter(config);
    const filenames = activeFilenames && activeFilenames.length > 0
      ? activeFilenames.filter(isSafeFilename)
      : await adapter.listDocuments(auth.tenantId, auth.roles);

    if (filenames.length === 0) {
      return NextResponse.json({ error: "No accessible documents found for evaluation" }, { status: 400 });
    }

    const summary = await evaluateRagCases({
      cases,
      config,
      filenames,
      tenantId: auth.tenantId,
      userRoles: auth.roles,
    });

    if (config.enableAuditLog !== false) {
      recordAuditEvent({
        action: "query",
        tenantId: auth.tenantId,
        roles: auth.roles,
        actorIp: ip,
        provider: config.provider,
        vectorStore: adapter.provider,
        details: {
          endpoint: "/api/eval",
          cases: summary.totalCases,
          passRate: summary.passRate,
          avgRecall: summary.avgRecall,
          avgGroundedness: summary.avgGroundedness,
        },
        status: "success",
      });
    }

    return NextResponse.json({ summary });
  } catch (error: any) {
    console.error("[Eval] Error:", sanitizeLog(error?.message || "Unknown error"));
    return NextResponse.json({ error: sanitizeLog(error?.message || "Evaluation failed") }, { status: 500 });
  }
}
