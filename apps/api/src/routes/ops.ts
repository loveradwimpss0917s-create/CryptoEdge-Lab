// Operational self-monitoring routes (docs/12 §2, docs/13 §7). Free-tier
// headroom is a first-class UI element, not something only discovered once
// a quota is already exhausted (2026-07 review, Task 7).

import { Hono } from "hono";
import type { Env } from "../env.js";

export const opsRoute = new Hono<{ Bindings: Env }>();

interface QuotaRow {
  resource: string;
  value: number;
  budget: number;
}

opsRoute.get("/quota", async (c) => {
  const dt = new Date().toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT resource, value, budget FROM quota_usage WHERE dt = ?1 ORDER BY resource ASC`
  )
    .bind(dt)
    .all<QuotaRow>();

  const quota = (results ?? []).map((row) => ({
    resource: row.resource,
    value: row.value,
    budget: row.budget,
    // Number.isFinite guards the "no fixed budget" resources (dailyBudgetFor
    // defaults to +Infinity), which have nothing meaningful to divide by.
    usage_ratio: Number.isFinite(row.budget) && row.budget > 0 ? row.value / row.budget : null
  }));

  return c.json({ dt, quota });
});
