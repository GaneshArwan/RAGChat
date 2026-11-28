import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/validation";
import { getVectorStoreAdapter } from "@/lib/vector-store";

/**
 * HEALTH CHECK API
 * Verifies connectivity to the active vector store (ChromaDB, Qdrant, or Pinecone).
 */

export async function GET(req: Request) {
  const ip = getClientIp(req);
  if (!await rateLimit(ip, undefined, 60, 60000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const vectorStoreProvider = (searchParams.get("vectorStoreProvider") || "chroma") as "chroma" | "qdrant" | "pinecone";
  const vectorStoreUrl = searchParams.get("vectorStoreUrl") || undefined;
  const vectorStoreApiKey = req.headers.get("x-vector-store-key") || undefined;
  const vectorStoreIndex = searchParams.get("vectorStoreIndex") || undefined;

  try {
    const adapter = getVectorStoreAdapter({
      vectorStoreProvider,
      vectorStoreUrl,
      vectorStoreApiKey,
      vectorStoreIndex,
    });
    const ok = await adapter.healthCheck();
    if (!ok) {
      return NextResponse.json({ status: "offline", provider: vectorStoreProvider }, { status: 503 });
    }
    return NextResponse.json({ status: "online", provider: vectorStoreProvider });
  } catch {
    console.warn(`[Health] ${vectorStoreProvider} heartbeat failed`);
    return NextResponse.json({ status: "offline", provider: vectorStoreProvider, error: "Database connection failure" }, { status: 503 });
  }
}
