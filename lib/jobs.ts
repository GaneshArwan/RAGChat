import crypto from "crypto";
import { IVectorStoreAdapter } from "./vector-store";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface IngestJob {
  id: string;
  tenantId: string;
  source: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  indexedFiles: string[];
  skippedUnchanged: string[];
  chunkCount: number;
  redactions: number;
  error?: string;
}

const MAX_JOBS = 200;
const jobRegistry = new Map<string, IngestJob>();
const contentHashRegistry = new Map<string, string>(); // `${tenantId}::${filename}` -> sha256

export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Delta-sync check: skips unchanged files and deletes stale chunks for modified files.
 */
export async function checkDeltaAndPrepare(
  tenantId: string,
  filename: string,
  content: string,
  adapter: IVectorStoreAdapter
): Promise<{ changed: boolean; hash: string }> {
  const key = `${tenantId}::${filename}`;
  const hash = computeContentHash(content);
  const existing = contentHashRegistry.get(key);

  if (existing === hash) {
    return { changed: false, hash };
  }

  if (existing && existing !== hash) {
    await adapter.deleteByFilename(filename, tenantId).catch(() => {});
  }
  return { changed: true, hash };
}

export function commitContentHash(tenantId: string, filename: string, hash: string) {
  const key = `${tenantId}::${filename}`;
  if (contentHashRegistry.size > 5000) {
    const firstKey = contentHashRegistry.keys().next().value;
    if (firstKey) contentHashRegistry.delete(firstKey);
  }
  contentHashRegistry.set(key, hash);
}

export function clearContentHash(tenantId: string, filename: string) {
  contentHashRegistry.delete(`${tenantId}::${filename}`);
}

export function enqueueIngestJob(
  tenantId: string,
  source: string,
  runner: () => Promise<{
    indexedFiles: string[];
    skippedUnchanged?: string[];
    chunkCount: number;
    redactions: number;
  }>
): IngestJob {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job: IngestJob = {
    id,
    tenantId,
    source,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    indexedFiles: [],
    skippedUnchanged: [],
    chunkCount: 0,
    redactions: 0,
  };

  if (jobRegistry.size >= MAX_JOBS) {
    const oldest = jobRegistry.keys().next().value;
    if (oldest) jobRegistry.delete(oldest);
  }
  jobRegistry.set(id, job);

  // Execute asynchronously with up to 2 attempts
  void (async () => {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      job.status = "running";
      job.attempts = attempt;
      job.updatedAt = new Date().toISOString();
      try {
        const result = await runner();
        job.status = "completed";
        job.indexedFiles = result.indexedFiles;
        job.skippedUnchanged = result.skippedUnchanged || [];
        job.chunkCount = result.chunkCount;
        job.redactions = result.redactions;
        job.updatedAt = new Date().toISOString();
        return;
      } catch (err: any) {
        if (attempt === maxAttempts) {
          job.status = "failed";
          job.error = err?.message || "Ingestion job failed";
          job.updatedAt = new Date().toISOString();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
  })();

  return job;
}

export function getJob(id: string): IngestJob | null {
  return jobRegistry.get(id) || null;
}

export function listJobs(tenantId?: string, limit: number = 50): IngestJob[] {
  const all = Array.from(jobRegistry.values()).reverse();
  const filtered = tenantId ? all.filter(j => j.tenantId === tenantId) : all;
  return filtered.slice(0, Math.max(1, Math.min(200, limit)));
}
