import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Document } from "@langchain/core/documents";

const require = createRequire(import.meta.url);
const validation = require("../.tmp-test/lib/validation.js");
const config = require("../.tmp-test/lib/config.js");
const auth = require("../.tmp-test/lib/auth.js");
const security = require("../.tmp-test/lib/security.js");
const chunking = require("../.tmp-test/lib/chunking.js");
const ragPipeline = require("../.tmp-test/lib/rag-pipeline.js");
const jobs = require("../.tmp-test/lib/jobs.js");
const evalMod = require("../.tmp-test/lib/eval.js");
const graphRag = require("../.tmp-test/lib/graph-rag.js");
const connectorTypes = require("../.tmp-test/lib/connectors/types.js");
const connectorRegistry = require("../.tmp-test/lib/connectors/registry.js");
const workerClient = require("../.tmp-test/lib/worker-client.js");

test("validation: filename safety and secret/password redaction", () => {
  assert.equal(validation.isSafeFilename("Quarterly Report (2026).pdf"), true);
  assert.equal(validation.isSafeFilename("../etc/passwd"), false);
  assert.equal(validation.isSafeFilename("dir/file.txt"), false);
  assert.equal(validation.isSafeFilename(" bad.txt "), false);

  const raw = "failed sk-proj_1234567890abcdef123456 and redis://:s3cr3t@redis.internal:6379";
  const cleaned = validation.sanitizeLog(raw);
  assert.equal(cleaned.includes("sk-proj_1234567890abcdef123456"), false);
  assert.equal(cleaned.includes("s3cr3t"), false);
  assert.ok(cleaned.includes("redis://"));
});

test("config: SSRF private host blocking", () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(config.isSafeHost("127.0.0.1"), false);
    assert.equal(config.isSafeHost("169.254.169.254"), false);
    assert.equal(config.isSafeHost("10.0.0.5"), false);
    assert.equal(config.isSafeHost("api.github.com"), true);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("auth: HS256 JWT signing, verification, and header spoofing prevention", () => {
  const prevSecret = process.env.RAGCHAT_JWT_SECRET;
  process.env.RAGCHAT_JWT_SECRET = "unit-test-super-secret-key";
  try {
    const token = auth.signSessionJwt(
      { sub: "alice", tenantId: "acme", roles: ["Engineering", "Member"] },
      process.env.RAGCHAT_JWT_SECRET,
      60
    );
    const claims = auth.verifySessionJwt(token, process.env.RAGCHAT_JWT_SECRET);
    assert.ok(claims);
    assert.equal(claims.tenantId, "acme");
    assert.deepEqual(claims.roles, ["engineering", "member"]);

    const spoofReq = new Request("http://localhost/api/chat", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const resolved = auth.resolveAuthContext(spoofReq, "evil-tenant", ["admin"]);
    assert.ok(resolved);
    assert.equal(resolved.authMode, "jwt-verified");
    assert.equal(resolved.tenantId, "acme");
    assert.equal(resolved.roles.includes("admin"), false);

    const invalidReq = new Request("http://localhost/api/chat");
    assert.equal(auth.resolveAuthContext(invalidReq, "acme", ["admin"]), null);
  } finally {
    if (prevSecret === undefined) delete process.env.RAGCHAT_JWT_SECRET;
    else process.env.RAGCHAT_JWT_SECRET = prevSecret;
  }
});

test("security: PII redaction, tenant/RBAC ACLs, and groundedness score", () => {
  const redacted = security.redactPii("Reach alice@example.com or 415-555-0199 with sk-test_12345678901234567890");
  assert.equal(redacted.redactions, 3);
  assert.ok(redacted.text.includes("[REDACTED_EMAIL]"));

  const meta = { tenantId: "tenant_a", allowedRoles: "finance, legal" };
  assert.equal(security.hasDocumentAccess(meta, "tenant_a", ["finance"]), true);
  assert.equal(security.hasDocumentAccess(meta, "tenant_a", ["intern"]), false);
  assert.equal(security.hasDocumentAccess(meta, "tenant_a", ["admin"]), true);
  assert.equal(security.hasDocumentAccess(meta, "tenant_b", ["finance"]), false);

  const score = security.computeGroundedness(
    "Revenue grew 20% [1].",
    [{ id: 1, content: "Revenue grew 20% in Q4 2026." }]
  );
  assert.equal(score.citedIds.includes(1), true);
  assert.ok(score.score > 50);
});

test("chunking & ragPipeline: contextual headers, BM25, RRF, and worker fallback", async () => {
  const { chunks, redactions } = await chunking.chunkDocumentsWithContext(
    [new Document({ pageContent: "# Architecture\nContact ops@acme.io for deployments." })],
    "arch.md",
    { tenantId: "acme", allowedRoles: ["member"], enablePiiRedaction: true }
  );
  assert.ok(chunks.length >= 1);
  assert.equal(redactions, 1);
  assert.ok(chunks[0].pageContent.includes("[Document: arch.md"));

  const corpus = [
    new Document({ pageContent: "Cooking recipes with butter", metadata: { filename: "cook.txt", chunkIndex: 0 } }),
    new Document({ pageContent: "Qdrant hybrid search and RRF ranking", metadata: { filename: "rag.txt", chunkIndex: 0 } }),
  ];
  const bm25Hits = ragPipeline.bm25Search("hybrid search rrf", corpus, 5);
  assert.equal(bm25Hits[0].doc.metadata.filename, "rag.txt");

  const fused = ragPipeline.reciprocalRankFusion([[corpus[0], corpus[1]], [corpus[1]]], 60);
  assert.equal(fused[0].metadata.filename, "rag.txt");

  const prevWorker = process.env.WORKER_URL;
  delete process.env.WORKER_URL;
  try {
    const fallback = await workerClient.bm25ViaWorkerOrLocal("hybrid rrf", corpus, 5);
    assert.equal(fallback[0].metadata.filename, "rag.txt");
  } finally {
    if (prevWorker !== undefined) process.env.WORKER_URL = prevWorker;
  }
});

test("jobs, eval & graph-rag: delta hash, Recall@K/MRR, and tenant-isolated graph traversal", async () => {
  const fakeAdapter = { deleted: [], async deleteByFilename(f) { this.deleted.push(f); } };
  const d1 = await jobs.checkDeltaAndPrepare("t1", "spec.md", "v1 content", fakeAdapter);
  assert.equal(d1.changed, true);
  jobs.commitContentHash("t1", "spec.md", d1.hash);

  const d2 = await jobs.checkDeltaAndPrepare("t1", "spec.md", "v1 content", fakeAdapter);
  assert.equal(d2.changed, false);

  const d3 = await jobs.checkDeltaAndPrepare("t1", "spec.md", "v2 updated content", fakeAdapter);
  assert.equal(d3.changed, true);
  assert.ok(fakeAdapter.deleted.includes("spec.md"));

  const recall = evalMod.computeRecallAtK([{ content: "Qdrant vector database", filename: "db.md" }], ["qdrant", "vector"], "db.md");
  const mrr = evalMod.computeMrr([{ content: "unrelated", filename: "a.md" }, { content: "qdrant", filename: "db.md" }], ["qdrant"], "db.md");
  assert.equal(recall, 1);
  assert.equal(mrr, 0.5);

  const added = graphRag.indexGraphFromDocs(
    [
      new Document({
        pageContent: "RAGChat connects to Qdrant for vector search. Qdrant stores Embeddings for RAGChat.",
        metadata: { filename: "system.md" },
      }),
    ],
    "graph-tenant-1"
  );
  assert.ok(added > 0);
  const hit = graphRag.queryGraphContext("How does RAGChat use Qdrant?", "graph-tenant-1");
  assert.ok(hit.edges.length > 0);
  assert.ok(hit.summary.includes("Qdrant"));

  const isolated = graphRag.queryGraphContext("How does RAGChat use Qdrant?", "other-tenant");
  assert.equal(isolated.edges.length, 0);
});

test("connectors: read-only SQL guard, CSV parser, and 36-connector registry", () => {
  assert.equal(connectorTypes.assertReadOnlySelect("SELECT id, name FROM users;"), "SELECT id, name FROM users");
  assert.throws(() => connectorTypes.assertReadOnlySelect("DROP TABLE users"));
  assert.throws(() => connectorTypes.assertReadOnlySelect("SELECT 1; DELETE FROM users"));

  const csvOut = connectorTypes.parseCsv("name,role\nAlice,admin");
  assert.ok(csvOut.includes("Row 1: name: Alice | role: admin"));

  const catalog = connectorRegistry.getConnectorCatalog();
  assert.equal(catalog.length, 36);
});
