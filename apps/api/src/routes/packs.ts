// Research Pack read path (docs/07 §2, docs/15 SONNET-2 V1 slice): serves
// the latest generated pack for a given kind so the SPA's [Copy for AI]
// button has something to fetch. research-worker is the only writer
// (POST /internal/ai-outputs); this route only reads.

import { Hono } from "hono";
import { AI_OUTPUT_KINDS } from "@cryptoedge/schema";
import type { Env } from "../env.js";

export const packsRoute = new Hono<{ Bindings: Env }>();

interface AiOutputRow {
  output_id: string;
  kind: string;
  ref_date: string | null;
  model: string;
  prompt_version: string;
  content_ref: string;
  created_at: number;
}

packsRoute.get("/:kind/latest", async (c) => {
  const kind = c.req.param("kind");
  if (!(AI_OUTPUT_KINDS as readonly string[]).includes(kind)) {
    return c.json({ type: "about:blank", title: `unknown pack kind: ${kind}`, status: 400 }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT output_id, kind, ref_date, model, prompt_version, content_ref, created_at
     FROM ai_outputs WHERE kind = ?1 ORDER BY created_at DESC LIMIT 1`
  )
    .bind(kind)
    .first<AiOutputRow>();
  if (!row) return c.json({ type: "about:blank", title: "no pack generated yet", status: 404 }, 404);

  const object = await c.env.LAKE.get(row.content_ref);
  if (!object) {
    return c.json({ type: "about:blank", title: "pack content missing from R2", status: 404 }, 404);
  }
  const content = await object.text();

  return c.json({
    output_id: row.output_id,
    kind: row.kind,
    ref_date: row.ref_date,
    model: row.model,
    prompt_version: row.prompt_version,
    created_at: row.created_at,
    content
  });
});
