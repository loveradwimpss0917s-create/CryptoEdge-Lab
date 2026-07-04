// Data Health (docs/06 SCR-05, docs/03 §6, docs/15 SONNET-4). V1 slice:
// live-computed per-stream quality score from `ingest_state`/`dq_issues`,
// not the full docs/03 §6 spec ("直近30日の取得成功率×欠損なし率" written
// daily into `latest_snapshots`) — there is no historical per-tick ingest
// log table to compute a real 30-day rolling rate from (`ingest_state`
// only ever holds the *current* watermark/status, one row per stream).
// Computed on every read instead, the same choice already made for
// Research Readiness (services/readiness.ts) rather than adding a new
// migration + batch job for a rolling window this pass doesn't have the
// underlying data for.

import type { Env } from "../env.js";

// schedule.ts (workers/ingest) is the single source of truth for which
// tier each adapter runs on; this mirrors it by stream_id substring since
// apps/api can't import from a sibling deployable. Follow-up per stream_id
// added there (2026-07, same maintenance burden already accepted for
// services/readiness.ts's DERIV_FEATURE_BASE_TABLE).
const CADENCE_MS_BY_SUBSTRING: [string, number][] = [
  ["candles_1m", 5 * 60_000],
  ["funding_rate", 5 * 60_000],
  ["okx_rest:open_interest", 5 * 60_000],
  ["long_short_ratio", 60 * 60_000],
  ["liquidations", 60 * 60_000],
  ["dvol", 60 * 60_000],
  ["cme_gap", 24 * 60 * 60_000],
  ["usdt_mint", 24 * 60 * 60_000],
  ["econ_calendar", 24 * 60 * 60_000],
  ["fear_greed", 24 * 60 * 60_000]
];
const DEFAULT_CADENCE_MS = 24 * 60 * 60_000;

function cadenceMsFor(streamId: string): number {
  for (const [needle, ms] of CADENCE_MS_BY_SUBSTRING) {
    if (streamId.includes(needle)) return ms;
  }
  return DEFAULT_CADENCE_MS;
}

/**
 * freshness: 1.0 within one cadence window, degrading linearly to 0 by
 * 3x cadence (mirrors DQ-02 "watermark が cadence×3 超過 → critical",
 * docs/03 §6). success: 1.0 with no error streak, degrading with
 * consecutive_errors. quality_score is their product — an approximation
 * of docs/03 §6's "取得成功率 × 欠損なし率", not the literal 30-day figure.
 */
export function computeStreamQualityScore(args: {
  streamId: string;
  lastRunAt: number | null;
  lastStatus: string | null;
  consecutiveErrors: number;
  now: number;
}): number {
  const cadenceMs = cadenceMsFor(args.streamId);
  const age = args.lastRunAt === null ? Number.POSITIVE_INFINITY : args.now - args.lastRunAt;
  const freshness = Math.max(0, Math.min(1, 1 - Math.max(0, age - cadenceMs) / (2 * cadenceMs)));
  const success = Math.max(0, 1 - args.consecutiveErrors / 10);
  return freshness * success;
}

export interface StreamHealthRow {
  stream_id: string;
  source_id: string;
  last_status: string | null;
  last_run_at: number | null;
  watermark_ts: number;
  consecutive_errors: number;
  quality_score: number;
  open_issues: { critical: number; warn: number; info: number };
}

export interface SourceHealth {
  source_id: string;
  name: string;
  status: string;
  streams: StreamHealthRow[];
}

export interface OpenIssue {
  issue_id: number;
  stream_id: string;
  rule_id: string;
  severity: string;
  detected_at: number;
  detail: string | null;
}

export interface DataHealthResult {
  overall_quality_score: number | null;
  sources: SourceHealth[];
  open_issues: OpenIssue[];
}

interface IngestStateRow {
  stream_id: string;
  watermark_ts: number;
  last_run_at: number | null;
  last_status: string | null;
  consecutive_errors: number;
}

interface DataSourceRow {
  source_id: string;
  name: string;
  status: string;
}

interface DqIssueCountRow {
  stream_id: string;
  severity: string;
  cnt: number;
}

// stream_id -> source_id is the prefix before the first ":" (every adapter
// in this codebase follows this convention, e.g. "okx_rest:candles_1m:...").
function sourceIdFor(streamId: string): string {
  return streamId.split(":")[0] ?? streamId;
}

export async function computeDataHealth(env: Env): Promise<DataHealthResult> {
  const now = Date.now();
  const [ingestStateResult, dataSourcesResult, dqCountsResult, recentIssuesResult] = await Promise.all([
    env.DB.prepare(
      `SELECT stream_id, watermark_ts, last_run_at, last_status, consecutive_errors FROM ingest_state`
    ).all<IngestStateRow>(),
    env.DB.prepare(`SELECT source_id, name, status FROM data_sources`).all<DataSourceRow>(),
    env.DB.prepare(
      `SELECT stream_id, severity, COUNT(*) AS cnt FROM dq_issues WHERE status = 'open' GROUP BY stream_id, severity`
    ).all<DqIssueCountRow>(),
    env.DB.prepare(
      `SELECT issue_id, stream_id, rule_id, severity, detected_at, detail FROM dq_issues
       WHERE status = 'open' ORDER BY detected_at DESC LIMIT 50`
    ).all<OpenIssue>()
  ]);

  const issuesByStream = new Map<string, { critical: number; warn: number; info: number }>();
  for (const row of dqCountsResult.results ?? []) {
    const counts = issuesByStream.get(row.stream_id) ?? { critical: 0, warn: 0, info: 0 };
    if (row.severity === "critical") counts.critical += row.cnt;
    else if (row.severity === "warn") counts.warn += row.cnt;
    else if (row.severity === "info") counts.info += row.cnt;
    issuesByStream.set(row.stream_id, counts);
  }

  // Sources marked 'disabled' (e.g. binance_rest/bybit_rest/coingecko --
  // permanently blocked by their WAF against Cloudflare Workers' shared
  // egress IPs, docs/03 §2.1, migration 0007) are a settled decision, not
  // an ongoing problem -- their dead streams still show up per-stream
  // (so the history is visible) but must not drag down
  // overall_quality_score or be read as "something is currently wrong"
  // (found live via the Data Health screen, 2026-07).
  const statusBySource = new Map((dataSourcesResult.results ?? []).map((s) => [s.source_id, s.status]));

  const streamsBySource = new Map<string, StreamHealthRow[]>();
  const scores: number[] = [];
  for (const row of ingestStateResult.results ?? []) {
    const qualityScore = computeStreamQualityScore({
      streamId: row.stream_id,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      consecutiveErrors: row.consecutive_errors,
      now
    });
    const sourceId = sourceIdFor(row.stream_id);
    if (statusBySource.get(sourceId) !== "disabled") scores.push(qualityScore);
    const list = streamsBySource.get(sourceId) ?? [];
    list.push({
      stream_id: row.stream_id,
      source_id: sourceId,
      last_status: row.last_status,
      last_run_at: row.last_run_at,
      watermark_ts: row.watermark_ts,
      consecutive_errors: row.consecutive_errors,
      quality_score: qualityScore,
      open_issues: issuesByStream.get(row.stream_id) ?? { critical: 0, warn: 0, info: 0 }
    });
    streamsBySource.set(sourceId, list);
  }

  const sources: SourceHealth[] = (dataSourcesResult.results ?? [])
    .map((source) => ({
      source_id: source.source_id,
      name: source.name,
      status: source.status,
      streams: (streamsBySource.get(source.source_id) ?? []).sort((a, b) => a.stream_id.localeCompare(b.stream_id))
    }))
    // Disabled sources sink to the bottom so a permanently-retired source
    // doesn't visually compete with ones that actually need attention.
    .sort((a, b) => (a.status === "disabled" ? 1 : 0) - (b.status === "disabled" ? 1 : 0));

  // Same reasoning as the score exclusion above: a disabled source's dq_issue
  // (e.g. DQ-02 stale, permanently) is not something to act on today.
  const openIssues = (recentIssuesResult.results ?? []).filter(
    (issue) => statusBySource.get(sourceIdFor(issue.stream_id)) !== "disabled"
  );

  return {
    overall_quality_score: scores.length > 0 ? scores.reduce((sum, s) => sum + s, 0) / scores.length : null,
    sources,
    open_issues: openIssues
  };
}
