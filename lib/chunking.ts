import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { redactPii, serializeRoles } from "./security";

const STRUCTURE_SEPARATORS = ["\n## ", "\n### ", "\n# ", "\n\n", "\n", ". ", " ", ""];

export const chunker = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
  separators: STRUCTURE_SEPARATORS,
});

export interface ChunkingOptions {
  tenantId?: string;
  allowedRoles?: string[] | string;
  enablePiiRedaction?: boolean;
  sourceType?: string;
}

function extractSectionHeading(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    const mdMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (mdMatch) return mdMatch[1].trim().slice(0, 80);
  }
  const first = lines[0];
  if (first && first.length <= 72 && !/[.!?]$/.test(first) && /^[A-Z0-9]/.test(first)) {
    return first;
  }
  return undefined;
}

/**
 * Splits documents with structure-aware boundaries, optionally redacts PII,
 * prepends contextual headers, and stamps tenant + RBAC ACL metadata.
 */
export async function chunkDocumentsWithContext(
  docs: Document[],
  filename: string,
  options: ChunkingOptions = {}
): Promise<{ chunks: Document[]; redactions: number }> {
  let totalRedactions = 0;
  const tenantId = options.tenantId || "default";
  const allowedRoles = serializeRoles(options.allowedRoles || ["*"]);
  const sourceType = options.sourceType || "upload";

  const preparedDocs = docs.map((doc) => {
    const pageNum = Number(doc.metadata?.loc?.pageNumber || doc.metadata?.pageNumber || doc.metadata?.page || 1);
    const safeMetadata: Record<string, any> = {
      filename,
      source: doc.metadata?.source || filename,
      page: Number.isFinite(pageNum) ? pageNum : 1,
      tenantId,
      allowedRoles,
      sourceType,
    };
    if (doc.metadata?.section) {
      safeMetadata.section = String(doc.metadata.section).slice(0, 80);
    }
    if (doc.metadata?.loc) {
      safeMetadata.loc = typeof doc.metadata.loc === "string"
        ? doc.metadata.loc
        : JSON.stringify(doc.metadata.loc);
    }
    return new Document({ pageContent: doc.pageContent, metadata: safeMetadata });
  });

  const split = await chunker.splitDocuments(preparedDocs);
  let lastSection: string | undefined;

  const chunks = split
    .filter(c => c.pageContent.trim().length > 0)
    .map((chunk, chunkIndex) => {
      let body = chunk.pageContent.trim();
      if (options.enablePiiRedaction) {
        const res = redactPii(body);
        body = res.text;
        totalRedactions += res.redactions;
      }

      const detected = extractSectionHeading(body) || chunk.metadata?.section;
      if (detected) lastSection = detected;
      const section = detected || lastSection;
      const page = chunk.metadata.page ?? 1;
      const header = `[Document: ${filename} | Page: ${page}${section ? ` | Section: ${section}` : ""}]`;

      return new Document({
        pageContent: `${header}\n${body}`,
        metadata: {
          ...chunk.metadata,
          ...(section ? { section } : {}),
          chunkIndex,
          tenantId,
          allowedRoles,
          sourceType,
        },
      });
    });

  return { chunks, redactions: totalRedactions };
}
