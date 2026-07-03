// DQ-10 quota headroom escalation (docs/12 §2, docs/13 §7). Free-tier
// budgets are meant to be a first-class monitoring target, not something
// discovered only once a resource is already exhausted (2026-07 review,
// Task 7).

import type { Env } from "../env.js";
import { recordDqIssue } from "../db.js";
import { notifyTelegram } from "../notify/telegram.js";

const WARN_RATIO = 0.8;

export async function checkQuotaThresholds(env: Env): Promise<void> {
  const dt = new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(`SELECT resource, value, budget FROM quota_usage WHERE dt = ?1`)
    .bind(dt)
    .all<{ resource: string; value: number; budget: number }>();

  // Sequential by design: `quota_usage` has at most a handful of resource
  // rows, and each iteration's own dq_issues check/insert must complete
  // before deciding whether to warn on the next resource.
  /* eslint-disable no-await-in-loop */
  for (const row of results ?? []) {
    if (!Number.isFinite(row.budget) || row.budget <= 0) continue;
    const ratio = row.value / row.budget;
    if (ratio < WARN_RATIO) continue;

    // One issue per resource per day: a fixed, deterministic stream_id
    // doubles as the "have we already warned about this today" key, so no
    // separate state table is needed.
    const streamId = `quota:${row.resource}:${dt}`;
    const already = await env.DB.prepare(`SELECT 1 FROM dq_issues WHERE rule_id = 'DQ-10' AND stream_id = ?1 LIMIT 1`)
      .bind(streamId)
      .first();
    if (already) continue;

    await recordDqIssue(env, {
      streamId,
      ruleId: "DQ-10",
      severity: "critical",
      detail: { resource: row.resource, value: row.value, budget: row.budget, ratio }
    });

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await notifyTelegram(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        `⚠️ CryptoEdge quota: ${row.resource} reached ${(ratio * 100).toFixed(0)}% of today's free-tier budget (${row.value}/${row.budget}).`
      ).catch(() => undefined);
    }
  }
  /* eslint-enable no-await-in-loop */
}
