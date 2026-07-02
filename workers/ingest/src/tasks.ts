// Retry-queue draining (docs/01 §3.1, docs/02 `ingest_tasks`). Every tick
// drains a bounded number of due retries *before* running its own regular
// collection, so a transient failure doesn't get starved by a busy tier.

import { drainDueTasks, markTaskDone, markTaskRetry } from "./db.js";
import type { Env } from "./env.js";
import { STREAMS_1D, STREAMS_1H, STREAMS_5M, STREAMS_WEEKLY } from "./schedule.js";
import type { Adapter } from "./adapters/types.js";

const ADAPTERS_BY_STREAM: Map<string, Adapter> = new Map(
  [...STREAMS_5M, ...STREAMS_1H, ...STREAMS_1D, ...STREAMS_WEEKLY].map((a) => [a.streamId, a])
);

const MAX_TASKS_PER_TICK = 10;

export async function drainRetryQueue(env: Env): Promise<{ attempted: number; recovered: number }> {
  const due = await drainDueTasks(env, MAX_TASKS_PER_TICK);
  let recovered = 0;
  // Sequential by design — see the matching note in index.ts runAdapters().
  /* eslint-disable no-await-in-loop */
  for (const task of due) {
    const adapter = ADAPTERS_BY_STREAM.get(task.stream_id);
    if (!adapter) {
      // Stream no longer registered (adapter removed/renamed) — drop the task rather than retry forever.
      await markTaskDone(env, task.task_id);
      continue;
    }
    try {
      await adapter.run(env);
      await markTaskDone(env, task.task_id);
      recovered += 1;
    } catch (err) {
      await markTaskRetry(env, task, err instanceof Error ? err.message : String(err));
    }
  }
  /* eslint-enable no-await-in-loop */
  return { attempted: due.length, recovered };
}
