import { generateText } from "ai";
import { AppConfig } from "./config";
import { getModelProvider } from "./models";
import { getVectorStoreAdapter } from "./vector-store";
import { executeRetrievalPipeline, formatNumberedContext } from "./rag-pipeline";
import { computeGroundedness } from "./security";

export interface EvalCaseInput {
  question: string;
  expectedKeywords?: string[];
  expectedFilename?: string;
}

export interface EvalCaseResult {
  question: string;
  answer: string;
  recallAtK: number;
  mrr: number;
  groundedness: number;
  latencyMs: number;
  retrievedFiles: string[];
  passed: boolean;
}

export interface EvalSummary {
  totalCases: number;
  passRate: number;
  avgRecall: number;
  avgMrr: number;
  avgGroundedness: number;
  avgLatencyMs: number;
  results: EvalCaseResult[];
}

export function computeRecallAtK(
  retrievedDocs: Array<{ content: string; filename: string }>,
  expectedKeywords: string[] = [],
  expectedFilename?: string
): number {
  if (retrievedDocs.length === 0) return 0;
  if (expectedFilename && retrievedDocs.some(d => d.filename === expectedFilename)) {
    if (expectedKeywords.length === 0) return 1;
  }
  if (expectedKeywords.length === 0) {
    return expectedFilename ? (retrievedDocs.some(d => d.filename === expectedFilename) ? 1 : 0) : 1;
  }
  const combined = retrievedDocs.map(d => d.content.toLowerCase()).join(" ");
  const matched = expectedKeywords.filter(kw => combined.includes(kw.toLowerCase())).length;
  return Number((matched / expectedKeywords.length).toFixed(2));
}

export function computeMrr(
  retrievedDocs: Array<{ content: string; filename: string }>,
  expectedKeywords: string[] = [],
  expectedFilename?: string
): number {
  for (let i = 0; i < retrievedDocs.length; i++) {
    const doc = retrievedDocs[i];
    const fileMatch = expectedFilename ? doc.filename === expectedFilename : true;
    const kwMatch = expectedKeywords.length === 0
      ? true
      : expectedKeywords.some(kw => doc.content.toLowerCase().includes(kw.toLowerCase()));
    if (fileMatch && kwMatch) {
      return Number((1 / (i + 1)).toFixed(2));
    }
  }
  return 0;
}

export async function evaluateRagCases(params: {
  cases: EvalCaseInput[];
  config: AppConfig;
  filenames: string[];
  tenantId: string;
  userRoles: string[];
}): Promise<EvalSummary> {
  const { cases, config, filenames, tenantId, userRoles } = params;
  const adapter = getVectorStoreAdapter(config);
  const model = getModelProvider(config);
  const rerankKey = config.rerankKeySource === "custom"
    ? (config.rerankApiKey || "")
    : config.rerankKeySource === "embedding"
    ? (config.embeddingKeySource === "custom" ? (config.embeddingApiKey || config.apiKey || "") : (config.apiKey || ""))
    : (config.apiKey || "");
  const rerankBaseUrl = config.rerankBaseUrl || config.baseUrl;

  const results: EvalCaseResult[] = [];

  for (const testCase of cases.slice(0, 10)) {
    const started = Date.now();
    const retrieval = await executeRetrievalPipeline({
      messages: [{ role: "user", content: testCase.question }],
      rawQuery: testCase.question,
      adapter,
      filenames,
      tenantId,
      userRoles,
      config,
      rerankKey,
      rerankBaseUrl,
    });

    const formatted = formatNumberedContext(retrieval.docs, config.contextFormat || "toon");
    const { text: answer } = await generateText({
      model,
      system:
        `Answer ONLY from numbered Context [1]..[N] below and cite inline with [1], [2].\n\nCONTEXT:\n${formatted}`,
      prompt: testCase.question,
      abortSignal: AbortSignal.timeout(25000),
    });

    const sources = retrieval.docs.map((d, i) => ({
      id: i + 1,
      content: d.pageContent,
      filename: String(d.metadata?.filename || "unknown"),
    }));
    const grounded = computeGroundedness(answer, sources);
    const recallAtK = computeRecallAtK(sources, testCase.expectedKeywords, testCase.expectedFilename);
    const mrr = computeMrr(sources, testCase.expectedKeywords, testCase.expectedFilename);
    const latencyMs = Date.now() - started;
    const passed = recallAtK >= 0.5 && grounded.score >= 40;

    results.push({
      question: testCase.question,
      answer,
      recallAtK,
      mrr,
      groundedness: grounded.score,
      latencyMs,
      retrievedFiles: Array.from(new Set(sources.map(s => s.filename))),
      passed,
    });
  }

  const n = Math.max(1, results.length);
  return {
    totalCases: results.length,
    passRate: Math.round((results.filter(r => r.passed).length / n) * 100),
    avgRecall: Number((results.reduce((s, r) => s + r.recallAtK, 0) / n).toFixed(2)),
    avgMrr: Number((results.reduce((s, r) => s + r.mrr, 0) / n).toFixed(2)),
    avgGroundedness: Math.round(results.reduce((s, r) => s + r.groundedness, 0) / n),
    avgLatencyMs: Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / n),
    results,
  };
}
