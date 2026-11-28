import { NextResponse } from "next/server";
import { getAuditEvents } from "@/lib/security";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/validation";

export async function GET(req: Request) {
  const ip = getClientIp(req);
  if (!await rateLimit(ip, undefined, 60, 60000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const tenantId = searchParams.get("tenantId") || undefined;
  const limitParam = parseInt(searchParams.get("limit") || "100", 10);
  const limit = Number.isNaN(limitParam) ? 100 : limitParam;

  return NextResponse.json({ events: getAuditEvents(tenantId, limit) });
}
