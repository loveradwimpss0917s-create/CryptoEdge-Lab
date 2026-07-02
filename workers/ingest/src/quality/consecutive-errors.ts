// DQ-02 "stale" escalation (docs/03 §6). A single failed fetch is normal
// and handled by the ingest_tasks retry; repeated consecutive failures on
// the same stream indicate the source itself is degraded and deserve a
// human's attention.

import type { Env } from "../env.js";
import { recordDqIssue } from "../db.js";

const CONSECUTIVE_ERROR_THRESHOLD = 3;

export async function checkAndEscalate(
  env: Env,
  streamId: string,
  consecutiveErrors: number
): Promise<void> {
  if (consecutiveErrors === CONSECUTIVE_ERROR_THRESHOLD) {
    await recordDqIssue(env, {
      streamId,
      ruleId: "DQ-02",
      severity: "critical",
      detail: { consecutiveErrors, note: "stream failed 3 consecutive ticks" }
    });
  }
}
