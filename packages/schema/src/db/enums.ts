// Enumerations shared across D1 tables. Kept as `as const` tuples so both the
// TS union type and a zod enum can be derived from a single list (docs/02).

export const EDGE_STATUSES = [
  "IDEA",
  "CANDIDATE",
  "TESTING",
  "VALIDATED",
  "PAPER",
  "ACTIVE",
  "DECAYING",
  "RETIRED",
  "REJECTED"
] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

export const EDGE_CATEGORIES = [
  "microstructure",
  "liquidation",
  "options",
  "seasonality",
  "etf_flow",
  "onchain",
  "stablecoin",
  "cross_asset",
  "behavioral",
  "event",
  "vol_regime",
  "cross_venue"
] as const;
export type EdgeCategory = (typeof EDGE_CATEGORIES)[number];

export const EDGE_ORIGINS = ["pdf_seed", "discovery", "ai_hypothesis", "manual"] as const;
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number];

// docs/06 §7.5, docs/14 §2 (Edge Pack v1): the one non-automatic input to
// Research Readiness. "A/B" = a signal_spec can be written with what's
// currently implemented ("SignalSpec待ち" once no version exists yet); "C/D"
// = a new data source, DSL node, or Discovery Engine methodology is needed
// first ("実装待ち"). NULL means unclassified -- readiness defaults that
// to SIGNAL_SPEC_PENDING (optimistic: assume writable until flagged
// otherwise) rather than blocking silently.
export const EDGE_READINESS_CLASSES = ["A", "B", "C", "D"] as const;
export type EdgeReadinessClass = (typeof EDGE_READINESS_CLASSES)[number];

export const EDGE_DIRECTIONS = ["long", "short", "both", "vol"] as const;
export type EdgeDirection = (typeof EDGE_DIRECTIONS)[number];

export const RUN_KINDS = ["screen", "full", "incremental", "decay_check"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ["running", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const VERDICTS = ["ADOPT", "WATCH", "REJECT"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const JOB_KINDS = [
  "eep_full",
  "eep_incremental",
  "discovery_batch",
  "regime_refit",
  "archive"
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "done",
  "failed",
  "cancelled"
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const DQ_SEVERITIES = ["info", "warn", "critical"] as const;
export type DqSeverity = (typeof DQ_SEVERITIES)[number];

export const DQ_STATUSES = ["open", "acked", "resolved", "wontfix"] as const;
export type DqStatus = (typeof DQ_STATUSES)[number];

export const INGEST_TASK_STATUSES = ["pending", "dead", "done"] as const;
export type IngestTaskStatus = (typeof INGEST_TASK_STATUSES)[number];

export const PAPER_SIGNAL_STATUSES = ["open", "closed", "expired", "invalidated"] as const;
export type PaperSignalStatus = (typeof PAPER_SIGNAL_STATUSES)[number];

export const REGIME_TREND = ["up", "down", "range"] as const;
export type RegimeTrend = (typeof REGIME_TREND)[number];

export const REGIME_VOL = ["low", "high", "extreme"] as const;
export type RegimeVol = (typeof REGIME_VOL)[number];

export const REGIME_LIQUIDITY = ["normal", "stressed"] as const;
export type RegimeLiquidity = (typeof REGIME_LIQUIDITY)[number];

export const FINDING_KINDS = [
  "conditional_return",
  "event_study",
  "interaction",
  "ml_importance",
  "anomaly",
  "changepoint"
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_STATUSES = ["new", "promoted", "dismissed", "duplicate"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const AI_OUTPUT_KINDS = [
  "briefing",
  "dossier_draft",
  "hypothesis",
  "dq_summary",
  "improvement"
] as const;
export type AiOutputKind = (typeof AI_OUTPUT_KINDS)[number];
