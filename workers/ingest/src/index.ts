// Ingest Worker entry point (docs/01 §3.1, §4.6). One scheduled handler
// routes every Cron Trigger tick to its tier and runs that tier's adapters
// directly — no Queues (Workers Free plan doesn't have them). Failures are
// caught per-adapter so one bad source never blocks the rest of the tick.

import { newId } from "@cryptoedge/shared";
import type { Env } from "./env.js";
import { enqueueIngestTask, touchIngestState, recordStreamError } from "./db.js";
import { checkAndEscalate } from "./quality/consecutive-errors.js";
import { streamsForTier, tierForCron, type Tier } from "./schedule.js";
import { drainRetryQueue } from "./tasks.js";
import { dispatchResearchEvent } from "./notify/github-dispatch.js";
import { notifyTelegram } from "./notify/telegram.js";

const GITHUB_REPO = "REPLACE_WITH_owner/CryptoEdge-Lab";

async function runAdapters(env: Env, tier: Tier): Promise<{ ok: number; failed: number }> {
  const adapters = streamsForTier(tier);
  let ok = 0;
  let failed = 0;

  // Sequential by design, not an oversight: this keeps concurrent D1 writes
  // and outbound fetches within a single tick predictable and makes the
  // per-tier subrequest budget (docs/13 §1) easy to reason about.
  /* eslint-disable no-await-in-loop */
  for (const adapter of adapters) {
    try {
      const result = await adapter.run(env);
      await touchIngestState(env, adapter.streamId, result.watermarkTs, "ok");
      ok += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const consecutiveErrors = await recordStreamError(env, adapter.streamId, message);
      await enqueueIngestTask(env, {
        taskId: newId(),
        streamId: adapter.streamId,
        windowStart: Date.now() - 60_000,
        windowEnd: Date.now(),
        error: message
      });
      await checkAndEscalate(env, adapter.streamId, consecutiveErrors);
      failed += 1;
    }
  }
  /* eslint-enable no-await-in-loop */
  return { ok, failed };
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const tier = tierForCron(controller.cron);
    ctx.waitUntil(handleTick(tier, env));
  },

  // Manual trigger for local dev / smoke testing (`wrangler dev` -> curl /__tick?tier=5m).
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__tick") {
      const tier = (url.searchParams.get("tier") ?? "5m") as Tier;
      const summary = await handleTick(tier, env);
      return new Response(JSON.stringify(summary), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("cryptoedge-ingest: not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

async function handleTick(
  tier: Tier,
  env: Env
): Promise<{ tier: string; retried: { attempted: number; recovered: number }; ok: number; failed: number }> {
  const retried = await drainRetryQueue(env);
  const { ok, failed } = await runAdapters(env, tier);

  if (failed > 0 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await notifyTelegram(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      `⚠️ CryptoEdge ingest tier=${tier}: ${failed} adapter(s) failed, queued for retry.`
    ).catch(() => {
      /* notification failures must never fail the tick */
    });
  }

  // docs/01 §3.2: the Worker is the primary trigger for research-worker,
  // GitHub's own `schedule:` is only a backup.
  if (tier === "1d" && env.GITHUB_PAT) {
    await dispatchResearchEvent({ githubPat: env.GITHUB_PAT, repo: GITHUB_REPO }, "research-daily").catch(
      () => undefined
    );
  }
  if (tier === "weekly" && env.GITHUB_PAT) {
    await dispatchResearchEvent({ githubPat: env.GITHUB_PAT, repo: GITHUB_REPO }, "research-weekly").catch(
      () => undefined
    );
  }

  return { tier, retried, ok, failed };
}
