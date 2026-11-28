import { NextResponse } from "next/server";
import { generateText } from "ai";
import { chunkDocumentsWithContext } from "@/lib/chunking";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { ConfigSchema } from "@/lib/config";
import { Document } from "@langchain/core/documents";
import { rateLimit } from "@/lib/rate-limit";
import { sanitizeLog, isSafeFilename, getClientIp } from "@/lib/validation";
import { parseCsv } from "@/lib/connectors/types";
import { getVectorStoreAdapter } from "@/lib/vector-store";
import { normalizeRoles, recordAuditEvent } from "@/lib/security";
import { getModelProvider } from "@/lib/models";
import { resolveAuthContext } from "@/lib/auth";
import { checkDeltaAndPrepare, commitContentHash } from "@/lib/jobs";
import { indexGraphFromDocs } from "@/lib/graph-rag";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    const configRaw = formData.get("config") as string;
    const allowedRolesRaw = formData.get("allowedRoles") as string | null;

    if (!files.length) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    let configJson;
    try {
      configJson = JSON.parse(configRaw || "{}");
    } catch {
      return NextResponse.json({ error: "Invalid configuration JSON" }, { status: 400 });
    }

    const configResult = ConfigSchema.safeParse(configJson);
    if (!configResult.success) {
      console.error("[Upload] Config validation failed:", configResult.error.format());
      return NextResponse.json({ error: "Invalid configuration", details: configResult.error.format() }, { status: 400 });
    }

    const config = configResult.data;
    const auth = resolveAuthContext(req, config.tenantId, config.userRoles);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ip = getClientIp(req);
    if (!await rateLimit(ip, config, 5, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const tenantId = auth.tenantId;
    const allowedRoles = allowedRolesRaw ? normalizeRoles(allowedRolesRaw) : auth.roles;
    const adapter = getVectorStoreAdapter(config);

    const allDocs: Document[] = [];
    const indexedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const unchangedFiles: string[] = [];
    const pendingHashes: Array<{ filename: string; hash: string }> = [];
    let totalRedactions = 0;

    for (const file of files) {
      if (!isSafeFilename(file.name)) {
        console.warn(`[Upload] Unsafe filename format: ${sanitizeLog(file.name)}. Skipping.`);
        skippedFiles.push(file.name);
        continue;
      }

      let docs: Document[] = [];
      const extension = file.name.split(".").pop()?.toLowerCase() || "";

      try {
        if (extension === "pdf") {
          const loader = new PDFLoader(file);
          docs = await loader.load();
        } else if (extension === "docx") {
          const loader = new DocxLoader(file);
          docs = await loader.load();
        } else if (extension === "csv") {
          const text = parseCsv(await file.text());
          docs = [new Document({ pageContent: text, metadata: { source: file.name } })];
        } else if (extension === "json") {
          const raw = await file.text();
          let formatted = raw;
          try {
            formatted = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            // Fall back to raw text if malformed JSON
          }
          docs = [new Document({ pageContent: formatted, metadata: { source: file.name } })];
        } else if (IMAGE_EXTENSIONS.has(extension)) {
          const buf = Buffer.from(await file.arrayBuffer());
          const model = getModelProvider(config);
          const { text: visionExtract } = await generateText({
            model,
            abortSignal: AbortSignal.timeout(25000),
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Extract all text, tables, metrics, diagrams, and key entities from this image in clean structured Markdown so it can be searched accurately.",
                  },
                  {
                    type: "image",
                    image: buf,
                  },
                ],
              },
            ],
          });
          docs = [new Document({ pageContent: visionExtract, metadata: { source: file.name, section: "Visual Extract" } })];
        } else if (["txt", "md", "ts", "js", "py", "css", "html"].includes(extension)) {
          const text = await file.text();
          docs = [new Document({ pageContent: text, metadata: { source: file.name } })];
        } else {
          console.warn(`[Upload] Unsupported file type: ${extension}. Skipping.`);
          skippedFiles.push(file.name);
          continue;
        }

        const combinedContent = docs.map(d => d.pageContent).join("\n");
        const delta = await checkDeltaAndPrepare(tenantId, file.name, combinedContent, adapter);
        if (!delta.changed) {
          unchangedFiles.push(file.name);
          indexedFiles.push(file.name);
          continue;
        }

        const { chunks, redactions } = await chunkDocumentsWithContext(docs, file.name, {
          tenantId,
          allowedRoles,
          enablePiiRedaction: !!config.enablePiiRedaction,
          sourceType: extension || "upload",
        });
        totalRedactions += redactions;
        if (chunks.length > 0) {
          allDocs.push(...chunks);
          indexedFiles.push(file.name);
          pendingHashes.push({ filename: file.name, hash: delta.hash });
        } else {
          skippedFiles.push(file.name);
        }
      } catch (err: any) {
        console.error(`[Upload] Failed to process ${sanitizeLog(file.name)}:`, sanitizeLog(err.message || "Unknown error"));
        skippedFiles.push(file.name);
      }
    }

    if (allDocs.length === 0 && unchangedFiles.length === 0) {
      return NextResponse.json({ error: "No valid documents processed", skippedFiles }, { status: 400 });
    }

    if (allDocs.length > 0) {
      await adapter.indexDocuments(allDocs);
      indexGraphFromDocs(allDocs, tenantId);
      pendingHashes.forEach(p => commitContentHash(tenantId, p.filename, p.hash));
    }

    if (config.enableAuditLog !== false) {
      recordAuditEvent({
        action: "ingest",
        tenantId,
        roles: allowedRoles,
        actorIp: ip,
        vectorStore: adapter.provider,
        details: {
          files: indexedFiles.length,
          unchanged: unchangedFiles.length,
          chunks: allDocs.length,
          redactions: totalRedactions,
        },
        status: "success",
      });
    }

    return NextResponse.json({
      message: unchangedFiles.length > 0 && allDocs.length === 0
        ? "All uploaded files unchanged (delta sync skipped)"
        : "Successfully indexed documents",
      indexedFiles,
      skippedFiles,
      unchangedFiles,
      redactions: totalRedactions,
    });
  } catch (error: any) {
    console.error("Upload error:", sanitizeLog(error.message || "Unknown error"));
    return NextResponse.json({ error: "Failed to process documents" }, { status: 500 });
  }
}
