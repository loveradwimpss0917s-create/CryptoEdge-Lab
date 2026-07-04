// GET /api/v1/data-health (docs/06 SCR-05, docs/15 SONNET-4).

import { Hono } from "hono";
import type { Env } from "../env.js";
import { computeDataHealth } from "../services/data-health.js";

export const dataHealthRoute = new Hono<{ Bindings: Env }>();

dataHealthRoute.get("/", async (c) => {
  const result = await computeDataHealth(c.env);
  return c.json(result);
});
