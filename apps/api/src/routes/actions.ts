// GET /api/v1/actions (docs/06 §1 item 1, docs/15 SONNET-7).

import { Hono } from "hono";
import type { Env } from "../env.js";
import { computeActionQueue } from "../services/action-queue.js";

export const actionsRoute = new Hono<{ Bindings: Env }>();

actionsRoute.get("/", async (c) => {
  const items = await computeActionQueue(c.env);
  return c.json({ items });
});
