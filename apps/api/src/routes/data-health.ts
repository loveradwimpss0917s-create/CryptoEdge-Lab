// GET /api/v1/data-health (docs/06 SCR-05, docs/15 SONNET-4).
// POST /:id/resolve (docs/19 S-02): manual close for a dq_issue that the
// auto-resolve-on-stream-recovery path (workers/ingest touchIngestState)
// won't catch on its own -- e.g. a permanently retired source, or a human
// who has already investigated and wants it off the board today.

import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AccessVariables } from "../middleware/require-access.js";
import { computeDataHealth } from "../services/data-health.js";
import { audit } from "../services/audit.js";

export const dataHealthRoute = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

dataHealthRoute.get("/", async (c) => {
  const result = await computeDataHealth(c.env);
  return c.json(result);
});

dataHealthRoute.post("/:id/resolve", async (c) => {
  const issueId = c.req.param("id");
  const issue = await c.env.DB.prepare(`SELECT issue_id, status FROM dq_issues WHERE issue_id = ?1`)
    .bind(issueId)
    .first<{ issue_id: number; status: string }>();
  if (!issue) return c.json({ type: "about:blank", title: "dq_issue not found", status: 404 }, 404);
  if (issue.status === "resolved") {
    return c.json({ issue_id: issue.issue_id, status: "resolved" });
  }

  await c.env.DB.prepare(`UPDATE dq_issues SET status = 'resolved', resolved_at = ?1 WHERE issue_id = ?2`)
    .bind(Date.now(), issueId)
    .run();

  const actor = `user:${c.get("userEmail")}`;
  await audit(c.env, actor, "dq_issue.resolve", `dq_issue:${issueId}`, {});
  return c.json({ issue_id: issue.issue_id, status: "resolved" });
});
