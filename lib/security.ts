import crypto from "crypto";
import { sanitizeLog } from "./validation";
import { tokenize } from "./rag-pipeline";

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: "query" | "ingest" | "delete" | "connector_sync" | "auth_denied";
  tenantId: string;
  roles: string[];
  actorIp: string;
  provider?: string;
  vectorStore?: string;
  details: Record<string, string | number | boolean>;
  status: "success" | "blocked" | "error";
}

const MAX_AUDIT_EVENTS = 500;
const auditRingBuffer: AuditEvent[] = [];

/**
 * Redacts common PII patterns (emails, SSNs, payment cards, phone numbers, and API keys).
 */
export function redactPii(text: string): { text: string; redactions: number } {
  if (!text) return { text, redactions: 0 };
  let redactions = 0;

  const replaceCount = (input: string, regex: RegExp, token: string): string =>
    input.replace(regex, () => {
      redactions++;
      return token;
    });

  let out = text;
  out = replaceCount(out, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  out = replaceCount(out, /\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");
  out = replaceCount(out, /\b(?:\d[ -]*?){13,16}\b/g, "[REDACTED_CARD]");
  out = replaceCount(out, /(?<!\w)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[REDACTED_PHONE]");
  out = replaceCount(out, /(sk-[a-zA-Z0-9_-]{20,})|(AIza[a-zA-Z0-9_-]{35})/g, "[REDACTED_KEY]");

  return { text: out, redactions };
}

export function normalizeRoles(roles?: string[] | string): string[] {
  if (!roles) return ["member"];
  const list = Array.isArray(roles) ? roles : roles.split(",");
  const cleaned = list.map(r => r.trim().toLowerCase()).filter(Boolean).slice(0, 20);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : ["member"];
}

export function serializeRoles(roles?: string[] | string): string {
  return normalizeRoles(roles).join(",");
}

/**
 * Enforces multi-tenant isolation and RBAC ACL checks at retrieval time.
 * Legacy documents without tenantId/allowedRoles default to tenant "default" and role "*".
 */
export function hasDocumentAccess(
  docMeta: Record<string, any> | undefined,
  tenantId: string = "default",
  userRoles: string[] = ["member"]
): boolean {
  const docTenant = (docMeta?.tenantId || "default").toString();
  if (docTenant !== tenantId) return false;

  const normalizedUserRoles = normalizeRoles(userRoles);
  if (normalizedUserRoles.includes("admin")) return true;

  const rawAllowed = docMeta?.allowedRoles;
  if (!rawAllowed) return true; // Backwards-compatible for pre-RBAC documents in same tenant

  const allowedList = normalizeRoles(rawAllowed);
  if (allowedList.includes("*")) return true;

  return allowedList.some(role => normalizedUserRoles.includes(role));
}

export function recordAuditEvent(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
  const entry: AuditEvent = {
    ...event,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  auditRingBuffer.unshift(entry);
  if (auditRingBuffer.length > MAX_AUDIT_EVENTS) {
    auditRingBuffer.length = MAX_AUDIT_EVENTS;
  }

  const sanitizedDetails = sanitizeLog(JSON.stringify(entry.details));
  console.log(
    `[AUDIT] ${entry.timestamp} action=${entry.action} tenant=${entry.tenantId} status=${entry.status} details=${sanitizedDetails}`
  );

  const auditFile = process.env.AUDIT_LOG_FILE;
  if (auditFile) {
    void import("fs/promises")
      .then(({ appendFile }) => appendFile(auditFile, `${JSON.stringify(entry)}\n`, "utf8"))
      .catch(() => {});
  }
  return entry;
}

export function getAuditEvents(tenantId?: string, limit: number = 100): AuditEvent[] {
  const filtered = tenantId
    ? auditRingBuffer.filter(e => e.tenantId === tenantId)
    : auditRingBuffer;
  return filtered.slice(0, Math.max(1, Math.min(500, limit)));
}

/**
 * Validates inline bracketed citations [1]..[N] and estimates lexical groundedness (0-100).
 */
export function computeGroundedness(
  answer: string,
  sources: Array<{ id: number; content: string }>
): { score: number; citedIds: number[]; invalidIds: number[]; coverage: number } {
  if (!answer.trim() || sources.length === 0) {
    return { score: 0, citedIds: [], invalidIds: [], coverage: 0 };
  }

  const validIdSet = new Set(sources.map(s => s.id));
  const citedSet = new Set<number>();
  const invalidSet = new Set<number>();

  const citationMatches = answer.matchAll(/\[(\d+)\]/g);
  for (const match of citationMatches) {
    const id = parseInt(match[1], 10);
    if (validIdSet.has(id)) citedSet.add(id);
    else invalidSet.add(id);
  }

  const answerTokens = Array.from(new Set(tokenize(answer)));
  const sourceTokenSet = new Set(sources.flatMap(s => tokenize(s.content)));

  let overlapCount = 0;
  for (const tok of answerTokens) {
    if (sourceTokenSet.has(tok)) overlapCount++;
  }

  const lexicalOverlap = answerTokens.length > 0 ? overlapCount / answerTokens.length : 0;
  const citationCoverage = sources.length > 0 ? Math.min(1, citedSet.size / Math.min(sources.length, 3)) : 0;
  const invalidPenalty = invalidSet.size * 15;

  const rawScore = Math.round((lexicalOverlap * 65 + citationCoverage * 35) - invalidPenalty);
  return {
    score: Math.max(0, Math.min(100, rawScore)),
    citedIds: Array.from(citedSet).sort((a, b) => a - b),
    invalidIds: Array.from(invalidSet).sort((a, b) => a - b),
    coverage: Math.round(lexicalOverlap * 100),
  };
}

/**
 * Verifies Bearer token against process.env.RAGCHAT_API_KEY using constant-time comparison.
 * When RAGCHAT_API_KEY is unset (local/BYOK mode), allows requests through.
 */
export function verifyBearerToken(req: Request): boolean {
  const expected = process.env.RAGCHAT_API_KEY;
  if (!expected) return true;

  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const provided = match[1].trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
