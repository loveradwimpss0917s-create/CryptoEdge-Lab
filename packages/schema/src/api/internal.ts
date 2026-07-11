// Contracts for the `/internal/*` API surface (docs/08 "Internal" section)
// used exclusively by research-worker (GitHub Actions, Python). These zod
// schemas are the TS half of the cross-language contract; the Python side
// (research/src/cryptoedge_research/io/internal_client.py) defines matching
// pydantic models validated against the same golden fixtures (docs/11 §4).

import { z } from "zod";
import { AI_OUTPUT_KINDS } from "../db/enums.js";

export const runMetricInputSchema = z.object({
  segment: z.string().min(1),
  metric: z.string().min(1),
  value: z.number(),
  // .nullable(): same Pydantic-always-sends-null-not-omitted issue as
  // regimeUpdateInputSchema below (found live: the first on-demand eval run
  // reached this endpoint and failed HTTP 400 "Expected number, received
  // null" for ci_lo/ci_hi/meta).
  ci_lo: z.number().nullable().optional(),
  ci_hi: z.number().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional()
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
  // Field name must be "passed", not "pass": the Python client's
  // VerdictReason model (io/internal_client.py) and every consumer
  // (edges.ts's response shape, the web UI's reason.passed) already agree
  // on "passed" — "pass" here was a typo that meant this endpoint could
  // never have accepted a real submission (found live: the first on-demand
  // eval run reached submit_verdict and failed HTTP 400 "pass: Required").
  passed: z.boolean(),
  value: z.number().nullable(),
  threshold: z.number().nullable()
});
export type VerdictReason = z.infer<typeof verdictReasonSchema>;

export const submitVerdictRequestSchema = z.object({
  verdict: z.enum(["ADOPT", "WATCH", "REJECT"]),
  score: z.number().min(0).max(100).nullable().optional(),
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
  // .nullable(): same Pydantic-null-vs-omitted issue as the other Optional
  // fields on this page (unused today, but built via the same
  // model_dump(mode="json") pattern that hits it as soon as it's wired up).
  novelty: z.number().min(0).max(1).nullable().optional()
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

// feature_defs is the D1 ledger for R2 `features/{feature_set_version}/`
// Parquet (docs/02 §feature_defs, docs/04 §3.1): every feature is
// registered here so it's traceable/reproducible, even though the values
// themselves live in R2 (2026-07 design audit TASK-2, Feature Store v1).
export const featureDefInputSchema = z.object({
  feature_id: z.string().min(1),
  version: z.number().int(),
  spec: z.record(z.string(), z.unknown()),
  cadence: z.string().min(1),
  lookback_required: z.string().nullable().optional(),
  family: z.string().min(1)
});
export type FeatureDefInput = z.infer<typeof featureDefInputSchema>;

export const submitFeatureDefsRequestSchema = z.object({
  feature_defs: z.array(featureDefInputSchema).min(1)
});
export type SubmitFeatureDefsRequest = z.infer<typeof submitFeatureDefsRequestSchema>;

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

// Derivatives backfill (docs/03 §2.1/§5, 2026-07 design audit TASK-3):
// research-worker backfills funding/OI/long-short-ratio history from
// data.binance.vision's static archives (candles' existing source, unlike
// the live OKX-fed trickle these tables otherwise get) and upserts it here.
export const fundingRateInputSchema = z.object({
  instrument_id: z.string().min(1),
  ts: z.number().int(),
  rate: z.number(),
  // .nullable(): same Pydantic-null-vs-omitted pattern as every other
  // Optional field on this page.
  predicted_rate: z.number().nullable().optional(),
  mark_price: z.number().nullable().optional()
});
export type FundingRateInput = z.infer<typeof fundingRateInputSchema>;

export const submitFundingRatesRequestSchema = z.object({
  funding_rates: z.array(fundingRateInputSchema).min(1)
});
export type SubmitFundingRatesRequest = z.infer<typeof submitFundingRatesRequestSchema>;

export const openInterestInputSchema = z.object({
  instrument_id: z.string().min(1),
  ts: z.number().int(),
  oi_base: z.number(),
  oi_usd: z.number().nullable().optional()
});
export type OpenInterestInput = z.infer<typeof openInterestInputSchema>;

export const longShortRatioInputSchema = z.object({
  instrument_id: z.string().min(1),
  ratio_type: z.string().min(1),
  ts: z.number().int(),
  long_ratio: z.number(),
  short_ratio: z.number(),
  ls_ratio: z.number().nullable().optional()
});
export type LongShortRatioInput = z.infer<typeof longShortRatioInputSchema>;

// Both arrays come from the same data.binance.vision "metrics" daily file
// (docs/03 §2.2), so one endpoint upserts both tables in a single batch
// rather than forcing research-worker to make two round trips per day.
export const submitDerivMetricsRequestSchema = z.object({
  open_interest: z.array(openInterestInputSchema).default([]),
  long_short_ratios: z.array(longShortRatioInputSchema).default([])
});
export type SubmitDerivMetricsRequest = z.infer<typeof submitDerivMetricsRequestSchema>;

export const liquidationInputSchema = z.object({
  instrument_id: z.string().min(1),
  ts: z.number().int(),
  long_liq_usd: z.number(),
  short_liq_usd: z.number(),
  events: z.number().int(),
  max_single_usd: z.number().nullable().optional(),
  source_id: z.string().min(1)
});
export type LiquidationInput = z.infer<typeof liquidationInputSchema>;

export const submitLiquidationsRequestSchema = z.object({
  liquidations: z.array(liquidationInputSchema).min(1)
});
export type SubmitLiquidationsRequest = z.infer<typeof submitLiquidationsRequestSchema>;

// Research Pack (docs/07 §2, docs/15 SONNET-2): research-worker generates
// the pack content itself (deterministic template, no AI call — docs/07 §3
// "AI なしで成立させる") and writes it to R2; this just registers the
// resulting ai_outputs row so the api Worker can serve it back via
// GET /api/v1/packs/:kind/latest. Replaces an earlier
// `briefing-ready`/`summary` stub that assumed a two-step
// notify-then-generate flow docs/07's actual design never called for.
// Historical event backfill (docs/17 ADR-1, docs/19 S-03): events was
// forward-collect-only, so every event-referencing signal_spec had zero
// historical samples to evaluate against. research-worker reconstructs
// cme_gap/usdt_mint/fomc history and upserts it here, sharing the same
// dedupe_key convention the live ingest adapters already use so backfilled
// rows and future live rows never collide.
export const eventInputSchema = z.object({
  event_type: z.string().min(1),
  ts: z.number().int(),
  announced_at: z.number().int().nullable().optional(),
  magnitude: z.number().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  source_id: z.string().min(1),
  dedupe_key: z.string().min(1)
});
export type EventInput = z.infer<typeof eventInputSchema>;

export const submitEventsRequestSchema = z.object({
  events: z.array(eventInputSchema).min(1)
});
export type SubmitEventsRequest = z.infer<typeof submitEventsRequestSchema>;

export const submitAiOutputRequestSchema = z.object({
  kind: z.enum(AI_OUTPUT_KINDS),
  ref_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  entity: z.string().nullable().optional(),
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  content_ref: z.string().min(1),
  tokens_in: z.number().int().nullable().optional(),
  tokens_out: z.number().int().nullable().optional()
});
export type SubmitAiOutputRequest = z.infer<typeof submitAiOutputRequestSchema>;
