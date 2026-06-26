import { NextResponse } from "next/server";
import { indexDocuments } from "@/lib/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { ConfigSchema } from "@/lib/config";
import { Document } from "@langchain/core/documents";
import { rateLimit } from "@/lib/rate-limit";
import { sanitizeLog } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    const configRaw = formData.get("config") as string;
    
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

    const ip = req.headers.get("x-forwarded-for") || "anonymous";
    if (!await rateLimit(ip, configResult.data, 5, 60000)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const allDocs: Document[] = [];
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    for (const file of files) {
      // Security check: validate filename to prevent directory traversal or malformed files
      const safeFilenamePattern = /^[a-zA-Z0-9_\-\.]+$/;
      if (!safeFilenamePattern.test(file.name)) {
        console.warn(`[Upload] Unsafe filename format: ${file.name}. Skipping.`);
        continue;
      }

      let docs: Document[] = [];
      const extension = file.name.split(".").pop()?.toLowerCase();

      try {
        if (extension === "pdf") {
          const loader = new PDFLoader(file);
          docs = await loader.load();
        } else if (extension === "docx") {
          const loader = new DocxLoader(file);
          docs = await loader.load();
        } else if (["txt", "md", "ts", "js", "py", "css", "html"].includes(extension || "")) {
          // Manual text loading to avoid 'langchain/document_loaders/fs/text' dependency
          const text = await file.text();
          docs = [new Document({ pageContent: text, metadata: { source: file.name } })];
        } else {
          console.warn(`[Upload] Unsupported file type: ${extension}. Skipping.`);
          continue;
        }

        const docsWithMetadata = docs.map((doc: Document) => {
          const pageNum = doc.metadata?.loc?.pageNumber || doc.metadata?.pageNumber || doc.metadata?.page || 1;
          
          const safeMetadata: Record<string, any> = {
            filename: file.name,
            source: file.name,
            page: pageNum
          };

          if (doc.metadata.loc) {
            safeMetadata.loc = typeof doc.metadata.loc === 'string' ? doc.metadata.loc : JSON.stringify(doc.metadata.loc);
          }

          return new Document({
            pageContent: doc.pageContent,
            metadata: safeMetadata
          });
        });

        const chunks = await splitter.splitDocuments(docsWithMetadata);
        allDocs.push(...chunks);
      } catch (err: any) {
        console.error(`[Upload] Failed to process ${file.name}:`, sanitizeLog(err.message || "Unknown error"));
      }
    }

    if (allDocs.length === 0) {
      return NextResponse.json({ error: "No valid documents processed" }, { status: 400 });
    }

    await indexDocuments(allDocs, configResult.data);

    return NextResponse.json({ message: "Successfully indexed documents" });
  } catch (error: any) {
    console.error("Upload error:", sanitizeLog(error.message || "Unknown error"));
    return NextResponse.json({ error: "Failed to process documents" }, { status: 500 });
  }
}
