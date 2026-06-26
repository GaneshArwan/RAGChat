import { NextResponse } from "next/server";
import { deleteDocumentsByFile } from "@/lib/embeddings";
import { ConfigSchema } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { sanitizeLog } from "@/lib/validation";

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const filename = searchParams.get("filename");
    const configRaw = searchParams.get("config");

    if (!filename || !configRaw) {
      return NextResponse.json({ error: "Filename and config are required" }, { status: 400 });
    }

    const safeFilenamePattern = /^[a-zA-Z0-9_\-\.]+$/;
    if (!safeFilenamePattern.test(filename)) {
      return NextResponse.json({ error: "Invalid filename format" }, { status: 400 });
    }

    let configJson;
    try {
      configJson = JSON.parse(configRaw);
    } catch {
      return NextResponse.json({ error: "Invalid configuration JSON" }, { status: 400 });
    }

    const configResult = ConfigSchema.safeParse(configJson);
    if (!configResult.success) {
      return NextResponse.json({ error: "Invalid configuration" }, { status: 400 });
    }

    const ip = req.headers.get("x-forwarded-for") || "anonymous";
    if (!await rateLimit(ip, configResult.data, 10, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    await deleteDocumentsByFile(filename, configResult.data);

    return NextResponse.json({ message: "Successfully deleted document" });
  } catch (error: any) {
    console.error("Delete error:", sanitizeLog(error.message || "Unknown error"));
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
}
