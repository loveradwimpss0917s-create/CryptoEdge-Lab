// DQ-02 "stale" escalation (docs/03 §6). A single failed fetch is normal
// and handled by the ingest_tasks retry; repeated consecutive failures on
// the same stream indicate the source itself is degraded and deserve a
// human's attention.

import type { Env } from "../env.js";
import { recordDqIssue } from "../db.js";

const CONSECUTIVE_ERROR_THRESHOLD = 3;
// A source rate-limiting Cloudflare's shared egress IP pool (HTTP 429) is a
// noisier, more self-healing signal than an actual outage/schema break —
// escalating it at the same threshold as a hard failure paged for things
// that quietly cleared up on their own (2026-07 review, Task 6).
const RATE_LIMIT_CONSECUTIVE_ERROR_THRESHOLD = 6;

export async function checkAndEscalate(
  env: Env,
  streamId: string,
  consecutiveErrors: number,
  lastError: string
): Promise<void> {
  const threshold = lastError.includes("HTTP 429")
    ? RATE_LIMIT_CONSECUTIVE_ERROR_THRESHOLD
    : CONSECUTIVE_ERROR_THRESHOLD;
  if (consecutiveErrors === threshold) {
    await recordDqIssue(env, {
      streamId,
      ruleId: "DQ-02",
      severity: "critical",
      detail: { consecutiveErrors, note: `stream failed ${threshold} consecutive ticks` }
    });
  }
}
