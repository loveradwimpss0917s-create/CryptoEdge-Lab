// Contracts for the `/internal/*` API surface (docs/08 "Internal" section)
// used exclusively by research-worker (GitHub Actions, Python). These zod
// schemas are the TS half of the cross-language contract; the Python side
// (research/src/cryptoedge_research/io/internal_client.py) defines matching
// pydantic models validated against the same golden fixtures (docs/11 §4).

import { z } from "zod";

export const runMetricInputSchema = z.object({
  segment: z.string().min(1),
  metric: z.string().min(1),
  value: z.number(),
  ci_lo: z.number().optional(),
  ci_hi: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional()
});
export type RunMetricInput = z.infer<typeof runMetricInputSchema>;

export const startRunRequestSchema = z.object({
  edge_version_id: z.string().min(1),
  protocol_version: z.string().min(1),
  run_kind: z.enum(["screen", "full", "incremental", "decay_check"]),
  dataset_hash: z.string().min(1),
  snapshot_id: z.string().min(1),
  seed: z.number().int(),
  config: z.record(z.string(), z.unknown()),
  requested_by: z.string().min(1),
  git_sha: z.string().min(1)
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const submitMetricsRequestSchema = z.object({
  metrics: z.array(runMetricInputSchema).min(1)
});
export type SubmitMetricsRequest = z.infer<typeof submitMetricsRequestSchema>;

export const verdictReasonSchema = z.object({
  check: z.string().min(1),
  pass: z.boolean(),
  value: z.number().nullable(),
  threshold: z.number().nullable()
});
export type VerdictReason = z.infer<typeof verdictReasonSchema>;

export const submitVerdictRequestSchema = z.object({
  verdict: z.enum(["ADOPT", "WATCH", "REJECT"]),
  score: z.number().min(0).max(100).optional(),
  reasons: z.array(verdictReasonSchema).min(1),
  thresholds_version: z.string().min(1)
});
export type SubmitVerdictRequest = z.infer<typeof submitVerdictRequestSchema>;

export const jobStatusUpdateSchema = z.object({
  status: z.enum(["dispatched", "running", "done", "failed"]),
  error: z.string().optional(),
  result_ref: z.string().optional()
});
export type JobStatusUpdate = z.infer<typeof jobStatusUpdateSchema>;

export const discoveryFindingInputSchema = z.object({
  finding_id: z.string().min(1),
  batch_id: z.string().min(1),
  kind: z.enum([
    "conditional_return",
    "event_study",
    "interaction",
    "ml_importance",
    "anomaly",
    "changepoint"
  ]),
  spec: z.record(z.string(), z.unknown()),
  stats: z.record(z.string(), z.unknown()),
  fdr_q: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1).optional()
});
export type DiscoveryFindingInput = z.infer<typeof discoveryFindingInputSchema>;

export const submitFindingsRequestSchema = z.object({
  findings: z.array(discoveryFindingInputSchema).min(1)
});
export type SubmitFindingsRequest = z.infer<typeof submitFindingsRequestSchema>;

export const regimeUpdateInputSchema = z.object({
  dt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trend: z.enum(["up", "down", "range"]),
  vol: z.enum(["low", "high", "extreme"]),
  liquidity: z.enum(["normal", "stressed"]),
  // .nullable(): the Python client (Pydantic) always serializes an unset
  // Optional[...] field as an explicit `null`, not an omitted key — plain
  // .optional() rejects that (2026-07: found live, first R2 regime backfill
  // failed HTTP 400 "Expected number, received null").
  hmm_state: z.number().int().nullable().optional(),
  probs: z.array(z.number()).nullable().optional(),
  model_version: z.string().min(1)
});
export type RegimeUpdateInput = z.infer<typeof regimeUpdateInputSchema>;

export const submitRegimesRequestSchema = z.object({
  regimes: z.array(regimeUpdateInputSchema).min(1)
});
export type SubmitRegimesRequest = z.infer<typeof submitRegimesRequestSchema>;

export const correlationUpdateInputSchema = z.object({
  edge_a: z.string().min(1),
  edge_b: z.string().min(1),
  window: z.enum(["1y", "all"]),
  signal_overlap: z.number().min(0).max(1).nullable().optional(),
  return_corr: z.number().min(-1).max(1).nullable().optional(),
  run_batch: z.string().nullable().optional()
});
export type CorrelationUpdateInput = z.infer<typeof correlationUpdateInputSchema>;

export const submitCorrelationsRequestSchema = z.object({
  correlations: z.array(correlationUpdateInputSchema).min(1)
});
export type SubmitCorrelationsRequest = z.infer<typeof submitCorrelationsRequestSchema>;

export const briefingReadyRequestSchema = z.object({
  ref_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.record(z.string(), z.unknown())
});
export type BriefingReadyRequest = z.infer<typeof briefingReadyRequestSchema>;
