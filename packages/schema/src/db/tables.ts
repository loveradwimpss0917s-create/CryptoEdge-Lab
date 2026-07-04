// Row shapes for every D1 table, mirroring migrations/0001_init.sql and
// docs/02_DATABASE.md column-for-column. `| null` marks nullable columns as
// D1/SQLite returns `null`, not `undefined`, for absent values.

import type {
  AiOutputKind,
  DqSeverity,
  DqStatus,
  EdgeCategory,
  EdgeDirection,
  EdgeOrigin,
  EdgeReadinessClass,
  EdgeStatus,
  FindingKind,
  FindingStatus,
  IngestTaskStatus,
  JobKind,
  JobStatus,
  PaperSignalStatus,
  RegimeLiquidity,
  RegimeTrend,
  RegimeVol,
  RunKind,
  RunStatus,
  Verdict
} from "./enums.js";

/** epoch milliseconds (UTC) — see docs/02 header conventions */
export type EpochMs = number;
/** 'YYYY-MM-DD' (UTC) */
export type DateKey = string;

// ---- 2.1 Metadata -----------------------------------------------------

export interface InstrumentRow {
  instrument_id: string;
  symbol: string;
  venue: string;
  kind: string;
  base: string;
  quote: string;
  tick_size: number | null;
  lot_size: number | null;
  is_active: 0 | 1;
  meta: string | null;
}

export interface DataSourceRow {
  source_id: string;
  name: string;
  tier: "free" | "freemium" | "paid";
  base_url: string | null;
  rate_limit: string | null;
  requires_key: 0 | 1;
  tos_note: string | null;
  status: "active" | "degraded" | "disabled";
}

export interface IngestStateRow {
  stream_id: string;
  watermark_ts: EpochMs;
  last_run_at: EpochMs | null;
  last_status: string | null;
  consecutive_errors: number;
}

export interface DqIssueRow {
  issue_id: number;
  detected_at: EpochMs;
  stream_id: string;
  rule_id: string;
  severity: DqSeverity;
  window_start: EpochMs | null;
  window_end: EpochMs | null;
  detail: string | null;
  status: DqStatus;
  resolved_at: EpochMs | null;
}

export interface IngestTaskRow {
  task_id: string;
  stream_id: string;
  window_start: EpochMs;
  window_end: EpochMs;
  attempts: number;
  next_attempt_at: EpochMs;
  status: IngestTaskStatus;
  last_error: string | null;
  created_at: EpochMs;
}

export interface LatestSnapshotRow {
  key: string;
  value: string; // JSON: {v, ts, ingested_at}
  updated_at: EpochMs;
}

export interface QuotaUsageRow {
  dt: DateKey;
  resource: string;
  value: number;
  budget: number;
}

export interface JobRow {
  job_id: string;
  kind: JobKind;
  payload: string; // JSON
  status: JobStatus;
  priority: number;
  created_at: EpochMs | null;
  started_at: EpochMs | null;
  finished_at: EpochMs | null;
  error: string | null;
  result_ref: string | null;
}

export interface AuditLogRow {
  id: number;
  at: EpochMs;
  actor: string;
  action: string;
  entity: string;
  detail: string | null;
}

export interface SettingsRow {
  key: string;
  value: string; // JSON
  updated_at: EpochMs;
}

// ---- 2.2 Market data ----------------------------------------------------

export type Timeframe = "1m" | "5m" | "1h" | "1d";

export interface CandleRow {
  instrument_id: string;
  tf: Timeframe;
  ts: EpochMs;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number | null;
  taker_buy_volume: number | null;
  trades: number | null;
  ingested_at: EpochMs;
}

export interface FundingRateRow {
  instrument_id: string;
  ts: EpochMs;
  rate: number;
  predicted_rate: number | null;
  mark_price: number | null;
  ingested_at: EpochMs;
}

export interface OpenInterestRow {
  instrument_id: string;
  ts: EpochMs;
  oi_base: number;
  oi_usd: number | null;
  ingested_at: EpochMs;
}

export type LongShortRatioType =
  | "global_account"
  | "top_account"
  | "top_position"
  | "taker_vol";

export interface LongShortRatioRow {
  instrument_id: string;
  ratio_type: LongShortRatioType;
  ts: EpochMs;
  long_ratio: number;
  short_ratio: number;
  ls_ratio: number | null;
  ingested_at: EpochMs;
}

export interface Liquidations5mRow {
  instrument_id: string;
  ts: EpochMs;
  long_liq_usd: number;
  short_liq_usd: number;
  events: number;
  max_single_usd: number | null;
  source_id: string;
  ingested_at: EpochMs;
}

export interface OrderbookSnapRow {
  instrument_id: string;
  ts: EpochMs;
  best_bid: number;
  best_ask: number;
  spread_bps: number;
  bid_depth_1pct: number | null;
  ask_depth_1pct: number | null;
  imbalance: number | null;
  ingested_at: EpochMs;
}

export interface OptionsSurfaceRow {
  underlying: string;
  ts: EpochMs;
  dvol: number | null;
  rv_30d: number | null;
  vrp: number | null;
  rr25_1m: number | null;
  fly25_1m: number | null;
  atm_iv_1m: number | null;
  total_oi_calls: number | null;
  total_oi_puts: number | null;
  max_pain: number | null;
  gex_proxy: number | null;
  ingested_at: EpochMs;
}

// ---- 2.3 Generic metrics -------------------------------------------------

export type MetricDomain = "onchain" | "macro" | "flow" | "sent" | "deriv" | "dex" | "mining";
export type MetricCadence = "5m" | "1h" | "1d" | "1w";
export type MetricUnit = "usd" | "btc" | "bps" | "ratio" | "index" | "count";

export interface MetricDefRow {
  metric_id: string;
  domain: MetricDomain;
  name: string;
  unit: MetricUnit;
  cadence: MetricCadence;
  source_id: string;
  pit_lag_ms: number;
  revisable: 0 | 1;
  retention_days: number | null;
  description: string | null;
}

export interface MetricRow {
  metric_id: string;
  ts: EpochMs;
  ingested_at: EpochMs;
  value: number;
  meta: string | null;
}

// ---- 2.4 Events -----------------------------------------------------------

export type EventType =
  | "fomc"
  | "cpi"
  | "nfp"
  | "option_expiry"
  | "cme_gap"
  | "usdt_mint"
  | "usdt_burn"
  | "whale_transfer"
  | "liq_cascade"
  | "etf_flow_extreme"
  | "halving"
  | "custom";

export interface EventRow {
  event_id: string;
  event_type: EventType;
  ts: EpochMs;
  announced_at: EpochMs | null;
  magnitude: number | null;
  payload: string | null; // JSON
  source_id: string;
  dedupe_key: string;
}

// ---- 2.5 Research (Edge registry) -----------------------------------------

export interface EdgeRow {
  edge_id: string;
  slug: string;
  title: string;
  category: EdgeCategory;
  status: EdgeStatus;
  hypothesis: string;
  rationale: string;
  counter_evidence: string | null;
  evidence: string | null; // JSON array
  origin: EdgeOrigin;
  pdf_ref: string | null;
  priors: string | null; // JSON
  discovery_finding_id: string | null;
  created_at: EpochMs;
  updated_at: EpochMs;
  // docs/06 §7.5, docs/14 §2 (Edge Pack v1, 2026-07 Research Readiness):
  // the one human/AI-curated input the readiness computation can't derive
  // from signal_spec/feature_defs/data alone.
  readiness_class: EdgeReadinessClass | null;
  readiness_blockers: string | null; // JSON string[] of missing implementation items (e.g. "options_surface.rr25 収集")
}

export interface EdgeVersionRow {
  version_id: string;
  edge_id: string;
  semver: string;
  signal_spec: string; // JSON, see domain/dsl.ts
  params: string; // JSON
  instrument_id: string;
  direction: EdgeDirection;
  horizon: string;
  entry_universe: string | null; // JSON
  cost_model: string; // JSON
  changelog: string | null;
  created_at: EpochMs;
  is_current: 0 | 1;
}

export interface EdgeTransitionRow {
  id: number;
  edge_id: string;
  from_status: EdgeStatus;
  to_status: EdgeStatus;
  at: EpochMs;
  actor: string;
  reason: string;
  run_id: string | null;
}

export interface EvalRunRow {
  run_id: string;
  edge_version_id: string;
  protocol_version: string;
  run_kind: RunKind;
  dataset_hash: string;
  snapshot_id: string;
  seed: number;
  config: string; // JSON
  status: RunStatus;
  started_at: EpochMs | null;
  finished_at: EpochMs | null;
  artifact_ref: string | null;
  requested_by: string;
  git_sha: string;
}

export interface EvalMetricRow {
  run_id: string;
  segment: string;
  metric: string;
  value: number;
  ci_lo: number | null;
  ci_hi: number | null;
  meta: string | null;
}

export interface VerdictRow {
  run_id: string;
  verdict: Verdict;
  score: number | null;
  reasons: string; // JSON array
  thresholds_version: string;
  decided_at: EpochMs;
}

export interface EdgeCorrelationRow {
  edge_a: string;
  edge_b: string;
  window: "1y" | "all";
  signal_overlap: number | null;
  return_corr: number | null;
  computed_at: EpochMs;
  run_batch: string | null;
}

export interface RegimeDailyRow {
  dt: DateKey;
  trend: RegimeTrend;
  vol: RegimeVol;
  liquidity: RegimeLiquidity;
  hmm_state: number | null;
  probs: string | null; // JSON
  model_version: string;
  computed_at: EpochMs;
}

export interface FeatureDefRow {
  feature_id: string;
  version: number;
  spec: string; // JSON
  cadence: string;
  lookback_required: string | null;
  family: string;
  status: "active" | "deprecated";
  created_at: EpochMs;
}

export interface DiscoveryFindingRow {
  finding_id: string;
  batch_id: string;
  kind: FindingKind;
  spec: string; // JSON
  stats: string; // JSON
  fdr_q: number;
  novelty: number | null;
  status: FindingStatus;
  promoted_edge_id: string | null;
  created_at: EpochMs;
}

export interface PaperSignalRow {
  signal_id: string;
  edge_version_id: string;
  status: PaperSignalStatus;
  direction: "long" | "short";
  ts_signal: EpochMs;
  ts_entry: EpochMs | null;
  ts_exit: EpochMs | null;
  entry_px: number | null;
  exit_px: number | null;
  ret_bps: number | null;
  ret_net_bps: number | null;
  trigger_snapshot: string; // JSON
}

export interface AiOutputRow {
  output_id: string;
  kind: AiOutputKind;
  ref_date: DateKey | null;
  entity: string | null;
  model: string;
  prompt_version: string;
  content_ref: string;
  tokens_in: number | null;
  tokens_out: number | null;
  status: "draft" | "reviewed" | "archived";
  created_at: EpochMs;
}
