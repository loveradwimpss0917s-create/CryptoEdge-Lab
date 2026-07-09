// docs/19 S-91: a research-worker run that claims an eval_runs row (POST
// /internal/runs) and then never submits a verdict (Actions runner OOM/
// timeout/cancelled workflow) leaves it stuck in status='running' forever —
// there was no equivalent of internal.ts's STUCK_DISPATCHED_MS reap for
// eval_runs (found live: cme-futures-gap-fill run_id=01KWN7C33MZ94ZRP26F659R0D5
// stuck since 2026-07-04). Screen/full runs finish in minutes, so anything
// still running after 6 hours is abandoned, not merely slow. Reaping happens
// lazily on the Edge list read path (below) so it's self-healing without a
// separate cron, matching the jobs table's existing pattern.
import type { Env } from "../env.js";

const STUCK_RUNNING_MS = 6 * 60 * 60 * 1000;

export async function reapStuckEvalRuns(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE eval_runs SET status = 'timeout', finished_at = ?1
     WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?2`
  )
    .bind(Date.now(), Date.now() - STUCK_RUNNING_MS)
    .run();
}
