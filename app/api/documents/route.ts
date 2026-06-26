import { NextResponse } from "next/server";
import { listDocuments, deleteDocumentsByFile } from "@/lib/embeddings";
import { ConfigSchema } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { sanitizeLog } from "@/lib/validation";

/**
 * DOCUMENT MANAGEMENT API
 * Supports listing and deleting indexed documents.
 */

export async function GET(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "anonymous";
    if (!await rateLimit(ip, undefined, 30, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const documents = await listDocuments();
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

    const safeFilenamePattern = /^[a-zA-Z0-9_\-\.]+$/;
    if (!safeFilenamePattern.test(filename)) {
      return NextResponse.json({ error: "Invalid filename format" }, { status: 400 });
    }

    const configResult = ConfigSchema.safeParse(config);
    if (!configResult.success) {
      return NextResponse.json({ error: "Invalid configuration" }, { status: 400 });
    }

    const ip = req.headers.get("x-forwarded-for") || "anonymous";
    if (!await rateLimit(ip, configResult.data, 10, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    await deleteDocumentsByFile(filename, configResult.data);
    return NextResponse.json({ message: `Successfully deleted ${filename}` });
  } catch (error: any) {
    console.error("[Documents] Delete error:", sanitizeLog(error.message || "Unknown error"));
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
}
