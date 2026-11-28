export interface StageTrace {
  rewriteMs: number;
  denseMs: number;
  bm25Ms: number;
  rrfMs: number;
  rerankMs: number;
  totalMs: number;
}

export class PipelineTracer {
  private readonly startMs: number;
  private readonly marks = new Map<string, number>();
  private readonly durations: Record<string, number> = {};

  constructor() {
    this.startMs = Date.now();
  }

  start(stage: keyof Omit<StageTrace, "totalMs">) {
    this.marks.set(stage, Date.now());
  }

  end(stage: keyof Omit<StageTrace, "totalMs">) {
    const started = this.marks.get(stage);
    if (started !== undefined) {
      this.durations[stage] = (this.durations[stage] || 0) + (Date.now() - started);
      this.marks.delete(stage);
    }
  }

  finish(): StageTrace {
    return {
      rewriteMs: this.durations.rewriteMs || 0,
      denseMs: this.durations.denseMs || 0,
      bm25Ms: this.durations.bm25Ms || 0,
      rrfMs: this.durations.rrfMs || 0,
      rerankMs: this.durations.rerankMs || 0,
      totalMs: Date.now() - this.startMs,
    };
  }
}
