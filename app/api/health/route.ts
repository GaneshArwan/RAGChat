import { NextResponse } from "next/server";
import { ChromaClient } from "chromadb";
import { rateLimit } from "@/lib/rate-limit";
import { sanitizeLog, validateSafeUrl } from "@/lib/validation";

/**
 * HEALTH CHECK API
 * Verifies connectivity to ChromaDB.
 */

export async function GET(req: Request) {
  const ip = req.headers.get("x-forwarded-for") || "anonymous";
  if (!await rateLimit(ip, undefined, 60, 60000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = process.env.CHROMA_URL || "http://localhost:8000";
  if (process.env.NODE_ENV === "production" && !validateSafeUrl(url)) {
    return NextResponse.json({ status: "offline", error: "Invalid database configuration" }, { status: 500 });
  }
  try {
    const parsed = new URL(url);
    const client = new ChromaClient({
      host: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
      ssl: parsed.protocol === "https:",
    });
    
    // Simple heartbeat check
    await client.heartbeat();
    
    return NextResponse.json({ status: "online" });
  } catch (error: any) {
    console.warn("[Health] Database heartbeat failed");
    return NextResponse.json({ status: "offline", error: "Database connection failure" }, { status: 503 });
  }
}
