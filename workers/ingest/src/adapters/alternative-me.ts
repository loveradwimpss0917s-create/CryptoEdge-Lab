// alternative.me Fear & Greed Index (docs/03 §2.5 `alternative_me`). No key,
// daily cadence. Demonstrates the generic `metrics` table path (docs/02 §2.3).

import { upsertLatestSnapshot, upsertMetric } from "../db.js";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson } from "./types.js";

export interface FngResponse {
  data: { value: string; value_classification: string; timestamp: string }[];
}

export function parseFearGreed(data: FngResponse): { ts: number; value: number; classification: string } {
  const point = data.data[0];
  if (!point) throw new Error("alternative.me returned no data points");
  return {
    ts: Number(point.timestamp) * 1000,
    value: Number(point.value),
    classification: point.value_classification
  };
}

export const alternativeMeFearGreedAdapter: Adapter = {
  sourceId: "alternative_me",
  streamId: "alternative_me:fear_greed",
  requestBudget: 1,
  async run(env): Promise<AdapterRunResult> {
    const raw = await fetchJson<FngResponse>("https://api.alternative.me/fng/?limit=1");
    const parsed = parseFearGreed(raw);
    await upsertMetric(env, "sent.fear_greed", parsed.ts, parsed.value, {
      classification: parsed.classification
    });
    await upsertLatestSnapshot(env, "fear_greed", {
      v: parsed.value,
      ts: parsed.ts,
      ingested_at: Date.now()
    });
    return { streamId: "alternative_me:fear_greed", rowsWritten: 1, watermarkTs: parsed.ts };
  }
};
