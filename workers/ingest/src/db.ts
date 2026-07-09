// D1 access helpers shared by all adapters. Every write goes through these
// so the write-budget bookkeeping (docs/13 §1: D1 Free write cap 100K
// rows/day) stays centralized instead of scattered across adapters.

import type { CandleRow } from "@cryptoedge/schema";
import { newId } from "@cryptoedge/shared";
import type { Env } from "./env.js";

export const BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const FIRST_BACKOFF_MS = BACKOFF_STEPS_MS[0] as number;

/** Best-effort daily write counter, itself cheap (one UPSERT) — docs/13 §7. */
export async function recordWrites(env: Env, resource: string, rows: number): Promise<void> {
  const dt = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO quota_usage (dt, resource, value, budget)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (dt, resource) DO UPDATE SET value = value + excluded.value`
  )
    .bind(dt, resource, rows, dailyBudgetFor(resource))
    .run();
}

function dailyBudgetFor(resource: string): number {
  // docs/13 §1 headline budgets. Kept here so the budget number always
  // travels with the metric it is compared against.
  switch (resource) {
    case "d1_writes":
      return 100_000;
    case "d1_reads":
      return 5_000_000;
    case "worker_requests":
      return 100_000;
    case "kv_writes":
      return 1_000;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

export async function upsertCandles(env: Env, rows: Omit<CandleRow, "ingested_at">[]): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO candles
       (instrument_id, tf, ts, open, high, low, close, volume, quote_volume, taker_buy_volume, trades, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT (instrument_id, tf, ts) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
       volume = excluded.volume, quote_volume = excluded.quote_volume,
       taker_buy_volume = excluded.taker_buy_volume, trades = excluded.trades,
       ingested_at = excluded.ingested_at`
  );
  const batch = rows.map((r) =>
    stmt.bind(
      r.instrument_id,
      r.tf,
      r.ts,
      r.open,
      r.high,
      r.low,
      r.close,
      r.volume,
      r.quote_volume ?? null,
      r.taker_buy_volume ?? null,
      r.trades ?? null,
      now
    )
  );
  await env.DB.batch(batch);
  await recordWrites(env, "d1_writes", rows.length);
}

export async function upsertLatestSnapshot(
  env: Env,
  key: string,
  value: unknown
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO latest_snapshots (key, value, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, JSON.stringify(value), now)
    .run();
  await recordWrites(env, "d1_writes", 1);
}

export interface UpsertMetricOptions {
  /**
   * Skip the insert entirely if the most recent row for this metric_id has
   * the same value (docs/13 §1 write budget — 2026-07 review finding: a
   * slow-moving metric sampled every 5m otherwise grows the `metrics` table
   * ~288 rows/day per instrument for no informational gain). Only safe for
   * metrics where "value unchanged since last sample" is genuinely
   * uninteresting to record — leave false (default) for anything where the
   * *fact* of a repeated observation itself matters.
   */
  skipIfUnchanged?: boolean;
}

export async function upsertMetric(
  env: Env,
  metricId: string,
  ts: number,
  value: number,
  meta?: unknown,
  options?: UpsertMetricOptions
): Promise<void> {
  if (options?.skipIfUnchanged) {
    const last = await env.DB.prepare(
      `SELECT value FROM metrics WHERE metric_id = ?1 ORDER BY ingested_at DESC LIMIT 1`
    )
      .bind(metricId)
      .first<{ value: number }>();
    if (last && last.value === value) return;
  }

  const ingestedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO metrics (metric_id, ts, ingested_at, value, meta)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (metric_id, ts, ingested_at) DO NOTHING`
  )
    .bind(metricId, ts, ingestedAt, value, meta ? JSON.stringify(meta) : null)
    .run();
  await recordWrites(env, "d1_writes", 1);
}

export interface EventInput {
  eventType: string;
  ts: number;
  announcedAt?: number;
  magnitude?: number;
  payload?: unknown;
  sourceId: string;
  /** Uniquely identifies this occurrence for a given event_type/source
   * (e.g. the CME-gap trading day, or the mint tx hash) so a re-run that
   * re-detects the same event is a no-op, not a duplicate row (docs/02
   * events.dedupe_key UNIQUE, docs/03 §6 DQ-05). */
  dedupeKey: string;
}

/** The Event Engine's write path (docs/04 §5, 2026-07 design audit
 * TASK-4): every adapter that detects a discrete event (cme_gap,
 * usdt_mint, econ_calendar entries, ...) goes through this, not a
 * hand-rolled INSERT, so dedupe/id-generation stays consistent. Returns
 * `true` if a new row was written, `false` if `dedupeKey` already existed
 * (DO NOTHING on conflict — events are immutable once recorded). */
export async function upsertEvent(env: Env, event: EventInput): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO events (event_id, event_type, ts, announced_at, magnitude, payload, source_id, dedupe_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (dedupe_key) DO NOTHING`
  )
    .bind(
      newId(),
      event.eventType,
      event.ts,
      event.announcedAt ?? null,
      event.magnitude ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
      event.sourceId,
      event.dedupeKey
    )
    .run();
  const written = (result.meta.changes ?? 0) > 0;
  if (written) await recordWrites(env, "d1_writes", 1);
  return written;
}

export async function touchIngestState(
  env: Env,
  streamId: string,
  watermarkTs: number,
  status: string
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ingest_state (stream_id, watermark_ts, last_run_at, last_status, consecutive_errors)
       VALUES (?1, ?2, ?3, ?4, 0)
       ON CONFLICT (stream_id) DO UPDATE SET
         watermark_ts = excluded.watermark_ts, last_run_at = excluded.last_run_at,
         last_status = excluded.last_status, consecutive_errors = 0`
    ).bind(streamId, watermarkTs, now, status),
    // docs/19 S-02: a stream recovering is exactly the signal that its
    // open dq_issues (DQ-02 stale-stream, DQ-TASK-DEAD retry-exhausted)
    // are no longer live problems -- close them here instead of leaving
    // them to accumulate forever (128 open rows found live, 2026-07-09
    // audit). Historical rows stay queryable via resolved_at, not deleted.
    env.DB.prepare(`UPDATE dq_issues SET status = 'resolved', resolved_at = ?1 WHERE stream_id = ?2 AND status = 'open'`).bind(
      now,
      streamId
    )
  ]);
}

/** Returns the resulting consecutive_errors count so callers can decide whether to escalate (DQ-02). */
export async function recordStreamError(env: Env, streamId: string, error: string): Promise<number> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO ingest_state (stream_id, watermark_ts, last_run_at, last_status, consecutive_errors)
     VALUES (?1, 0, ?2, ?3, 1)
     ON CONFLICT (stream_id) DO UPDATE SET
       last_run_at = excluded.last_run_at, last_status = excluded.last_status,
       consecutive_errors = ingest_state.consecutive_errors + 1
     RETURNING consecutive_errors`
  )
    .bind(streamId, now, `error:${error.slice(0, 200)}`)
    .first<{ consecutive_errors: number }>();
  return row?.consecutive_errors ?? 1;
}

export async function recordDqIssue(
  env: Env,
  args: {
    streamId: string;
    ruleId: string;
    severity: "info" | "warn" | "critical";
    windowStart?: number;
    windowEnd?: number;
    detail?: unknown;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dq_issues (detected_at, stream_id, rule_id, severity, window_start, window_end, detail, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open')`
  )
    .bind(
      Date.now(),
      args.streamId,
      args.ruleId,
      args.severity,
      args.windowStart ?? null,
      args.windowEnd ?? null,
      args.detail ? JSON.stringify(args.detail) : null
    )
    .run();
}

export async function enqueueIngestTask(
  env: Env,
  args: { taskId: string; streamId: string; windowStart: number; windowEnd: number; error: string }
): Promise<void> {
  // docs/02 ingest_tasks: exponential backoff expressed via next_attempt_at.
  await env.DB.prepare(
    `INSERT INTO ingest_tasks (task_id, stream_id, window_start, window_end, attempts, next_attempt_at, status, last_error, created_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, 'pending', ?6, ?7)`
  )
    .bind(
      args.taskId,
      args.streamId,
      args.windowStart,
      args.windowEnd,
      Date.now() + FIRST_BACKOFF_MS,
      args.error.slice(0, 500),
      Date.now()
    )
    .run();
}

export interface DueIngestTask {
  task_id: string;
  stream_id: string;
  window_start: number;
  window_end: number;
  attempts: number;
}

export async function drainDueTasks(env: Env, limit = 10): Promise<DueIngestTask[]> {
  const { results } = await env.DB.prepare(
    `SELECT task_id, stream_id, window_start, window_end, attempts
     FROM ingest_tasks
     WHERE status = 'pending' AND next_attempt_at <= ?1
     ORDER BY next_attempt_at ASC
     LIMIT ?2`
  )
    .bind(Date.now(), limit)
    .all<DueIngestTask>();
  return results ?? [];
}

export async function markTaskDone(env: Env, taskId: string): Promise<void> {
  await env.DB.prepare(`UPDATE ingest_tasks SET status = 'done' WHERE task_id = ?1`)
    .bind(taskId)
    .run();
}

export async function markTaskRetry(
  env: Env,
  task: DueIngestTask,
  error: string
): Promise<void> {
  const nextAttempts = task.attempts + 1;
  if (nextAttempts >= BACKOFF_STEPS_MS.length + 1) {
    await env.DB.prepare(`UPDATE ingest_tasks SET status = 'dead', attempts = ?2, last_error = ?3 WHERE task_id = ?1`)
      .bind(task.task_id, nextAttempts, error.slice(0, 500))
      .run();
    await recordDqIssue(env, {
      streamId: task.stream_id,
      ruleId: "DQ-TASK-DEAD",
      severity: "critical",
      windowStart: task.window_start,
      windowEnd: task.window_end,
      detail: { error, attempts: nextAttempts }
    });
    return;
  }
  const step = BACKOFF_STEPS_MS[Math.min(nextAttempts - 1, BACKOFF_STEPS_MS.length - 1)] ?? BACKOFF_STEPS_MS[0]!;
  await env.DB.prepare(
    `UPDATE ingest_tasks SET attempts = ?2, next_attempt_at = ?3, last_error = ?4 WHERE task_id = ?1`
  )
    .bind(task.task_id, nextAttempts, Date.now() + step, error.slice(0, 500))
    .run();
}
