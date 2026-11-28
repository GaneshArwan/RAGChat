import { Document } from "@langchain/core/documents";

export interface GraphEdge {
  source: string;
  relation: string;
  target: string;
  docName: string;
  tenantId: string;
}

const MAX_TENANTS = 100;
const MAX_EDGES_PER_TENANT = 600;

const g = globalThis as unknown as {
  __ragchatGraphStore?: Map<string, GraphEdge[]>;
};

const graphStore: Map<string, GraphEdge[]> =
  g.__ragchatGraphStore || (g.__ragchatGraphStore = new Map());

const STOP_ENTITIES = new Set([
  "The", "This", "That", "These", "Those", "When", "Where", "What", "Which", "With",
  "From", "Into", "About", "After", "Before", "Because", "Since", "While", "However",
  "Therefore", "Also", "Note", "True", "False", "Null", "None", "Select", "Where",
]);

const RELATION_VERBS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\bdepends?\s+on\b/i, label: "depends_on" },
  { regex: /\bconnects?\s+to\b/i, label: "connects_to" },
  { regex: /\bintegrates?\s+with\b/i, label: "integrates_with" },
  { regex: /\breplaces?\b/i, label: "replaces" },
  { regex: /\bmanages?\b/i, label: "manages" },
  { regex: /\bowns?\b/i, label: "owns" },
  { regex: /\bstores?\b/i, label: "stores" },
  { regex: /\buses?\b/i, label: "uses" },
  { regex: /\bcalls?\b/i, label: "calls" },
  { regex: /\bdeploys?\s+to\b/i, label: "deploys_to" },
  { regex: /\bauthenticates?\s+via\b/i, label: "authenticates_via" },
  { regex: /\breads?\s+from\b/i, label: "reads_from" },
  { regex: /\bwrites?\s+to\b/i, label: "writes_to" },
];

export function extractEntities(text: string): string[] {
  const seen = new Set<string>();
  const entities: string[] = [];

  const patterns = [
    /\b[A-Z][a-zA-Z0-9_-]{1,}(?:\s+[A-Z][a-zA-Z0-9_-]{1,}){0,2}\b/g,
    /\b[A-Z]{2,10}\b/g,
    /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g,
    /`([a-zA-Z0-9_.:/-]{2,40})`/g,
  ];

  for (const pat of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pat.exec(text)) !== null) {
      const candidate = (match[1] ?? match[0]).trim();
      if (candidate.length < 2 || candidate.length > 48) continue;
      if (STOP_ENTITIES.has(candidate)) continue;
      const key = candidate.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entities.push(candidate);
      }
      if (entities.length >= 40) return entities;
    }
  }
  return entities;
}

function detectRelation(sentence: string): string {
  for (const r of RELATION_VERBS) {
    if (r.regex.test(sentence)) return r.label;
  }
  return "related_to";
}

export function extractGraphTriples(
  text: string,
  docName: string,
  tenantId: string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const sentences = text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .slice(0, 120);

  for (const sentence of sentences) {
    const ents = extractEntities(sentence);
    if (ents.length < 2) continue;
    const relation = detectRelation(sentence);
    const maxPairs = Math.min(ents.length, 4);
    for (let i = 0; i < maxPairs - 1; i++) {
      const source = ents[i];
      const target = ents[i + 1];
      if (source.toLowerCase() === target.toLowerCase()) continue;
      const dedupeKey = `${source.toLowerCase()}|${relation}|${target.toLowerCase()}|${docName}`;
      if (edgeKeys.has(dedupeKey)) continue;
      edgeKeys.add(dedupeKey);
      edges.push({ source, relation, target, docName, tenantId });
      if (edges.length >= 45) return edges;
    }
  }
  return edges;
}

export function indexGraphFromDocs(docs: Document[], tenantId: string): number {
  const safeTenant = tenantId || "default";
  if (!graphStore.has(safeTenant) && graphStore.size >= MAX_TENANTS) {
    const oldestKey = graphStore.keys().next().value;
    if (oldestKey) graphStore.delete(oldestKey);
  }

  const existing = graphStore.get(safeTenant) || [];
  const incomingDocNames = new Set(
    docs.map((d) => String(d.metadata?.filename || d.metadata?.source || "unknown"))
  );

  // Replace stale triples for updated documents
  const retained = existing.filter((e) => !incomingDocNames.has(e.docName));
  const newEdges: GraphEdge[] = [];

  for (const doc of docs) {
    const docName = String(doc.metadata?.filename || doc.metadata?.source || "unknown");
    const extracted = extractGraphTriples(doc.pageContent, docName, safeTenant);
    newEdges.push(...extracted);
  }

  const combined = [...retained, ...newEdges].slice(-MAX_EDGES_PER_TENANT);
  graphStore.set(safeTenant, combined);
  return newEdges.length;
}

export function deleteGraphByDoc(docName: string, tenantId: string): void {
  const safeTenant = tenantId || "default";
  const existing = graphStore.get(safeTenant);
  if (!existing) return;
  graphStore.set(
    safeTenant,
    existing.filter((e) => e.docName !== docName)
  );
}

export function queryGraphContext(
  query: string,
  tenantId: string,
  activeFilenames?: string[],
  limit = 12
): { summary: string; edges: GraphEdge[]; matchedEntities: string[] } {
  const safeTenant = tenantId || "default";
  const tenantEdges = graphStore.get(safeTenant) || [];
  if (tenantEdges.length === 0) {
    return { summary: "", edges: [], matchedEntities: [] };
  }

  const allowedSet =
    activeFilenames && activeFilenames.length > 0 ? new Set(activeFilenames) : null;
  const scopedEdges = allowedSet
    ? tenantEdges.filter((e) => allowedSet.has(e.docName))
    : tenantEdges;

  if (scopedEdges.length === 0) {
    return { summary: "", edges: [], matchedEntities: [] };
  }

  const queryTerms = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((t) => t.length >= 3)
  );
  const queryEntities = extractEntities(query).map((e) => e.toLowerCase());
  for (const qe of queryEntities) queryTerms.add(qe);

  // Hop 1: direct entity/term hits
  const hop1: GraphEdge[] = [];
  const neighborhood = new Set<string>();
  const matchedEntities = new Set<string>();

  for (const edge of scopedEdges) {
    const srcL = edge.source.toLowerCase();
    const tgtL = edge.target.toLowerCase();
    const hitSrc = [...queryTerms].some((t) => srcL.includes(t));
    const hitTgt = [...queryTerms].some((t) => tgtL.includes(t));
    if (hitSrc || hitTgt) {
      hop1.push(edge);
      neighborhood.add(srcL);
      neighborhood.add(tgtL);
      if (hitSrc) matchedEntities.add(edge.source);
      if (hitTgt) matchedEntities.add(edge.target);
    }
  }

  // Hop 2: 1-hop graph neighborhood expansion
  const combined = [...hop1];
  const seen = new Set(hop1.map((e) => `${e.source}|${e.relation}|${e.target}|${e.docName}`));

  for (const edge of scopedEdges) {
    if (combined.length >= limit) break;
    const key = `${edge.source}|${edge.relation}|${edge.target}|${edge.docName}`;
    if (seen.has(key)) continue;
    if (neighborhood.has(edge.source.toLowerCase()) || neighborhood.has(edge.target.toLowerCase())) {
      seen.add(key);
      combined.push(edge);
    }
  }

  const topEdges = combined.slice(0, limit);
  if (topEdges.length === 0) {
    return { summary: "", edges: [], matchedEntities: [] };
  }

  const summaryLines = topEdges.map(
    (e) => `- ${e.source} --[${e.relation}]--> ${e.target} (source: ${e.docName})`
  );
  return {
    summary: `Knowledge Graph Relationships (${topEdges.length} triples):\n${summaryLines.join("\n")}`,
    edges: topEdges,
    matchedEntities: [...matchedEntities],
  };
}

export function getGraphStats(tenantId: string): { edgeCount: number } {
  const safeTenant = tenantId || "default";
  return { edgeCount: (graphStore.get(safeTenant) || []).length };
}
