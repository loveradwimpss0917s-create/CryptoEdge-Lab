-- CryptoEdge Lab — D1 initial schema
-- Source of truth: docs/02_DATABASE.md. Do not edit columns/types here without
-- updating that document first (docs/00 §3 principle: docs are the input).
--
-- Conventions:
--   * All timestamp columns are epoch milliseconds (UTC) INTEGER.
--   * Date-key columns are TEXT 'YYYY-MM-DD' (UTC).
--   * JSON columns are TEXT (validated by packages/schema zod before write).
--   * Forward-only migrations: never DROP or ALTER a column in a later file.

PRAGMA foreign_keys = ON;

-- ============================================================
-- 2.1 Metadata
-- ============================================================

CREATE TABLE instruments (
  instrument_id TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,
  venue         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  base          TEXT NOT NULL,
  quote         TEXT NOT NULL,
  tick_size     REAL,
  lot_size      REAL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  meta          TEXT
);
CREATE INDEX idx_instruments_venue_symbol ON instruments (venue, symbol);

CREATE TABLE data_sources (
  source_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  tier          TEXT NOT NULL,
  base_url      TEXT,
  rate_limit    TEXT,
  requires_key  INTEGER NOT NULL,
  tos_note      TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE ingest_state (
  stream_id           TEXT PRIMARY KEY,
  watermark_ts         INTEGER NOT NULL,
  last_run_at          INTEGER,
  last_status          TEXT,
  consecutive_errors   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dq_issues (
  issue_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at   INTEGER NOT NULL,
  stream_id     TEXT NOT NULL,
  rule_id       TEXT NOT NULL,
  severity      TEXT NOT NULL,
  window_start  INTEGER,
  window_end    INTEGER,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  resolved_at   INTEGER
);
CREATE INDEX idx_dq_issues_status_severity ON dq_issues (status, severity);
CREATE INDEX idx_dq_issues_stream_detected ON dq_issues (stream_id, detected_at);

-- Cloudflare Queues free-tier substitute (docs/01 §3.1)
CREATE TABLE ingest_tasks (
  task_id           TEXT PRIMARY KEY,
  stream_id         TEXT NOT NULL,
  window_start      INTEGER NOT NULL,
  window_end        INTEGER NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  last_error        TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_ingest_tasks_status_next ON ingest_tasks (status, next_attempt_at);

-- KV snapshot substitute (docs/01 §4.3): KV free tier write budget (1,000/day)
-- cannot absorb 5-minute-cadence latest-value updates.
CREATE TABLE latest_snapshots (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Free-tier headroom ledger (docs/13 §7)
CREATE TABLE quota_usage (
  dt        TEXT NOT NULL,
  resource  TEXT NOT NULL,
  value     REAL NOT NULL,
  budget    REAL NOT NULL,
  PRIMARY KEY (dt, resource)
);

CREATE TABLE jobs (
  job_id        TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 5,
  created_at    INTEGER,
  started_at    INTEGER,
  finished_at   INTEGER,
  error         TEXT,
  result_ref    TEXT
);
CREATE INDEX idx_jobs_status_priority_created ON jobs (status, priority, created_at);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX idx_audit_log_entity_at ON audit_log (entity, at);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ============================================================
-- 2.2 Market data (dedicated tables)
-- ============================================================

CREATE TABLE candles (
  instrument_id       TEXT NOT NULL,
  tf                  TEXT NOT NULL,
  ts                  INTEGER NOT NULL,
  open                REAL NOT NULL,
  high                REAL NOT NULL,
  low                 REAL NOT NULL,
  close               REAL NOT NULL,
  volume              REAL NOT NULL,
  quote_volume        REAL,
  taker_buy_volume    REAL,
  trades              INTEGER,
  ingested_at         INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, tf, ts)
);
CREATE INDEX idx_candles_tf_ts ON candles (tf, ts);

CREATE TABLE funding_rates (
  instrument_id     TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  rate              REAL NOT NULL,
  predicted_rate    REAL,
  mark_price        REAL,
  ingested_at       INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, ts)
);

CREATE TABLE open_interest (
  instrument_id   TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  oi_base         REAL NOT NULL,
  oi_usd          REAL,
  ingested_at     INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, ts)
);

CREATE TABLE long_short_ratios (
  instrument_id   TEXT NOT NULL,
  ratio_type      TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  long_ratio      REAL NOT NULL,
  short_ratio     REAL NOT NULL,
  ls_ratio        REAL,
  ingested_at     INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, ratio_type, ts)
);

CREATE TABLE liquidations_5m (
  instrument_id     TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  long_liq_usd      REAL NOT NULL DEFAULT 0,
  short_liq_usd     REAL NOT NULL DEFAULT 0,
  events            INTEGER NOT NULL DEFAULT 0,
  max_single_usd    REAL,
  source_id         TEXT NOT NULL,
  ingested_at       INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, ts, source_id)
);

CREATE TABLE orderbook_snaps (
  instrument_id       TEXT NOT NULL,
  ts                  INTEGER NOT NULL,
  best_bid            REAL NOT NULL,
  best_ask            REAL NOT NULL,
  spread_bps          REAL NOT NULL,
  bid_depth_1pct      REAL,
  ask_depth_1pct      REAL,
  imbalance           REAL,
  ingested_at         INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, ts)
);

CREATE TABLE options_surface (
  underlying        TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  dvol              REAL,
  rv_30d            REAL,
  vrp               REAL,
  rr25_1m           REAL,
  fly25_1m          REAL,
  atm_iv_1m         REAL,
  total_oi_calls    REAL,
  total_oi_puts     REAL,
  max_pain          REAL,
  gex_proxy         REAL,
  ingested_at       INTEGER NOT NULL,
  PRIMARY KEY (underlying, ts)
);

-- ============================================================
-- 2.3 Generic metrics (long format, bitemporal)
-- ============================================================

CREATE TABLE metric_defs (
  metric_id         TEXT PRIMARY KEY,
  domain            TEXT NOT NULL,
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,
  cadence           TEXT NOT NULL,
  source_id         TEXT NOT NULL REFERENCES data_sources(source_id),
  pit_lag_ms        INTEGER NOT NULL DEFAULT 0,
  revisable         INTEGER NOT NULL DEFAULT 0,
  retention_days    INTEGER,
  description       TEXT
);

CREATE TABLE metrics (
  metric_id     TEXT NOT NULL REFERENCES metric_defs(metric_id),
  ts            INTEGER NOT NULL,
  ingested_at   INTEGER NOT NULL,
  value         REAL NOT NULL,
  meta          TEXT,
  PRIMARY KEY (metric_id, ts, ingested_at)
);
CREATE INDEX idx_metrics_metric_ingested ON metrics (metric_id, ingested_at);

-- ============================================================
-- 2.4 Events
-- ============================================================

CREATE TABLE events (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  announced_at    INTEGER,
  magnitude       REAL,
  payload         TEXT,
  source_id       TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_events_type_ts ON events (event_type, ts);

-- ============================================================
-- 2.5 Research (Edge registry)
-- ============================================================

CREATE TABLE edges (
  edge_id                   TEXT PRIMARY KEY,
  slug                      TEXT NOT NULL UNIQUE,
  title                     TEXT NOT NULL,
  category                  TEXT NOT NULL,
  status                    TEXT NOT NULL,
  hypothesis                TEXT NOT NULL,
  rationale                 TEXT NOT NULL,
  counter_evidence          TEXT,
  evidence                  TEXT,
  origin                    TEXT NOT NULL,
  pdf_ref                   TEXT,
  priors                    TEXT,
  discovery_finding_id      TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);
CREATE INDEX idx_edges_status ON edges (status);
CREATE INDEX idx_edges_category_status ON edges (category, status);

CREATE TABLE edge_versions (
  version_id        TEXT PRIMARY KEY,
  edge_id           TEXT NOT NULL REFERENCES edges(edge_id),
  semver            TEXT NOT NULL,
  signal_spec       TEXT NOT NULL,
  params            TEXT NOT NULL,
  instrument_id     TEXT NOT NULL REFERENCES instruments(instrument_id),
  direction         TEXT NOT NULL,
  horizon           TEXT NOT NULL,
  entry_universe    TEXT,
  cost_model        TEXT NOT NULL,
  changelog         TEXT,
  created_at        INTEGER NOT NULL,
  is_current        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (edge_id, semver)
);
CREATE INDEX idx_edge_versions_edge_current ON edge_versions (edge_id, is_current);

CREATE TABLE edge_transitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_id       TEXT NOT NULL REFERENCES edges(edge_id),
  from_status   TEXT NOT NULL,
  to_status     TEXT NOT NULL,
  at            INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  run_id        TEXT
);
CREATE INDEX idx_edge_transitions_edge_at ON edge_transitions (edge_id, at);

CREATE TABLE eval_runs (
  run_id              TEXT PRIMARY KEY,
  edge_version_id     TEXT NOT NULL REFERENCES edge_versions(version_id),
  protocol_version    TEXT NOT NULL,
  run_kind            TEXT NOT NULL,
  dataset_hash        TEXT NOT NULL,
  snapshot_id         TEXT NOT NULL,
  seed                INTEGER NOT NULL,
  config              TEXT NOT NULL,
  status              TEXT NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER,
  artifact_ref        TEXT,
  requested_by        TEXT NOT NULL,
  git_sha             TEXT NOT NULL
);
CREATE INDEX idx_eval_runs_version_finished ON eval_runs (edge_version_id, finished_at);
CREATE INDEX idx_eval_runs_kind_finished ON eval_runs (run_kind, finished_at);

CREATE TABLE eval_metrics (
  run_id    TEXT NOT NULL REFERENCES eval_runs(run_id),
  segment   TEXT NOT NULL,
  metric    TEXT NOT NULL,
  value     REAL NOT NULL,
  ci_lo     REAL,
  ci_hi     REAL,
  meta      TEXT,
  PRIMARY KEY (run_id, segment, metric)
);

CREATE TABLE verdicts (
  run_id                TEXT PRIMARY KEY REFERENCES eval_runs(run_id),
  verdict               TEXT NOT NULL,
  score                 REAL,
  reasons               TEXT NOT NULL,
  thresholds_version    TEXT NOT NULL,
  decided_at            INTEGER NOT NULL
);

CREATE TABLE edge_correlations (
  edge_a            TEXT NOT NULL,
  edge_b            TEXT NOT NULL,
  window            TEXT NOT NULL,
  signal_overlap    REAL,
  return_corr       REAL,
  computed_at       INTEGER NOT NULL,
  run_batch         TEXT,
  PRIMARY KEY (edge_a, edge_b, window)
);

CREATE TABLE regimes_daily (
  dt              TEXT PRIMARY KEY,
  trend           TEXT NOT NULL,
  vol             TEXT NOT NULL,
  liquidity       TEXT NOT NULL,
  hmm_state       INTEGER,
  probs           TEXT,
  model_version   TEXT NOT NULL,
  computed_at     INTEGER NOT NULL
);

CREATE TABLE feature_defs (
  feature_id            TEXT PRIMARY KEY,
  version               INTEGER NOT NULL,
  spec                  TEXT NOT NULL,
  cadence               TEXT NOT NULL,
  lookback_required     TEXT,
  family                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            INTEGER NOT NULL
);

CREATE TABLE discovery_findings (
  finding_id          TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL,
  kind                TEXT NOT NULL,
  spec                TEXT NOT NULL,
  stats               TEXT NOT NULL,
  fdr_q               REAL NOT NULL,
  novelty             REAL,
  status              TEXT NOT NULL DEFAULT 'new',
  promoted_edge_id    TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_discovery_findings_batch ON discovery_findings (batch_id);
CREATE INDEX idx_discovery_findings_status_fdr ON discovery_findings (status, fdr_q);

CREATE TABLE paper_signals (
  signal_id           TEXT PRIMARY KEY,
  edge_version_id     TEXT NOT NULL REFERENCES edge_versions(version_id),
  status              TEXT NOT NULL,
  direction           TEXT NOT NULL,
  ts_signal           INTEGER NOT NULL,
  ts_entry            INTEGER,
  ts_exit             INTEGER,
  entry_px            REAL,
  exit_px             REAL,
  ret_bps             REAL,
  ret_net_bps         REAL,
  trigger_snapshot    TEXT NOT NULL
);
CREATE INDEX idx_paper_signals_version_ts ON paper_signals (edge_version_id, ts_signal);
CREATE INDEX idx_paper_signals_status ON paper_signals (status);

CREATE TABLE ai_outputs (
  output_id         TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  ref_date          TEXT,
  entity            TEXT,
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  content_ref       TEXT NOT NULL,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  status            TEXT NOT NULL DEFAULT 'draft',
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_ai_outputs_kind_ref_date ON ai_outputs (kind, ref_date);
