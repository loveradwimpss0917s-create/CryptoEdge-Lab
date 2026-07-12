// Action Queue (docs/06 §1 item 1, SCR-01, docs/15 SONNET-7 V1 slice).
// "システムが人間に求める意思決定を単一のキューとして表示" -- V1 sources:
// SCREEN_DONE/FULL_DONE Research Readiness states (docs/06 §7.2: "人間の
// レビュー待ちを意味し、Action Queue の項目源にもなる") and open DQ
// critical issues. Findings-based items (discovery_findings) are V2 scope
// (Discovery Engine not yet built, docs/09 §6 P2) -- not fabricated here.

import { computeReadinessForEdges, type EdgeReadinessInputRow } from "./readiness.js";
import type { Env } from "../env.js";

export type ActionKind = "approval" | "review" | "dq";

export interface ActionItem {
  kind: ActionKind;
  edge_id: string | null;
  title: string;
  detail: string;
  // docs/06 §1 item 1 "ゼロインボックス型" + §3 SCR-01 wireframe (item ①
  // shows [承認][却下] inline, without a click-through to Dossier first).
  // Only kinds with a single deterministic action carry one: "approval"
  // (ADOPT verdict, TESTING status -- accept via edge_id) and "dq" (via
  // issue_id, reusing the resolve endpoint S-02 already built). "review"
  // items (SCREEN_DONE, or FULL_DONE without ADOPT) have no single correct
  // action -- the wireframe itself only shows a summary line for those,
  // matching genuine human judgment being required.
  issue_id: number | null;
}

interface EdgeRow extends EdgeReadinessInputRow {
  title: string;
}

interface LatestVerdictRow {
  edge_id: string;
  verdict: "ADOPT" | "WATCH" | "REJECT";
}

interface DqIssueRow {
  issue_id: number;
  stream_id: string;
  rule_id: string;
  severity: string;
  detected_at: number;
}

// Latest full-run verdict for each edge's *current* version -- matches
// readiness.ts's FULL_DONE semantics (hasFullRunDone is keyed off the
// current version's eval_runs, not any historical version).
async function latestVerdictsByEdge(env: Env, edgeIds: string[]): Promise<Map<string, "ADOPT" | "WATCH" | "REJECT">> {
  if (edgeIds.length === 0) return new Map();
  const placeholders = edgeIds.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await env.DB.prepare(
    `SELECT e.edge_id, v.verdict FROM edges e
     JOIN edge_versions ev ON ev.edge_id = e.edge_id AND ev.is_current = 1
     JOIN eval_runs r ON r.edge_version_id = ev.version_id AND r.run_kind = 'full'
     JOIN verdicts v ON v.run_id = r.run_id
     WHERE e.edge_id IN (${placeholders})
       AND v.decided_at = (
         SELECT MAX(v2.decided_at) FROM verdicts v2
         JOIN eval_runs r2 ON r2.run_id = v2.run_id
         WHERE r2.edge_version_id = ev.version_id AND r2.run_kind = 'full'
       )`
  )
    .bind(...edgeIds)
    .all<LatestVerdictRow>();
  return new Map((results ?? []).map((r) => [r.edge_id, r.verdict]));
}

export async function computeActionQueue(env: Env): Promise<ActionItem[]> {
  const [edgesResult, dqResult] = await Promise.all([
    env.DB.prepare(`SELECT edge_id, title, status, readiness_class, readiness_blockers FROM edges`).all<EdgeRow>(),
    env.DB.prepare(
      `SELECT issue_id, stream_id, rule_id, severity, detected_at FROM dq_issues
       WHERE status = 'open' AND severity = 'critical' ORDER BY detected_at DESC LIMIT 10`
    ).all<DqIssueRow>()
  ]);
  const edges = edgesResult.results ?? [];
  const readinessByEdge = await computeReadinessForEdges(env, edges);

  const fullDoneEdgeIds = edges.filter((e) => readinessByEdge.get(e.edge_id)?.state === "FULL_DONE").map((e) => e.edge_id);
  const verdictByEdge = await latestVerdictsByEdge(env, fullDoneEdgeIds);

  const items: ActionItem[] = [];

  for (const edge of edges) {
    const state = readinessByEdge.get(edge.edge_id)?.state;
    if (state === "FULL_DONE") {
      const verdict = verdictByEdge.get(edge.edge_id);
      if (verdict === "ADOPT" && edge.status === "TESTING") {
        items.push({
          kind: "approval",
          edge_id: edge.edge_id,
          title: edge.title,
          detail: "ADOPT -> TESTING→VALIDATEDの承認待ち",
          issue_id: null
        });
      } else {
        items.push({
          kind: "review",
          edge_id: edge.edge_id,
          title: edge.title,
          detail: `full評価結果 (${verdict ?? "verdict未確定"}) のレビュー待ち`,
          issue_id: null
        });
      }
    } else if (state === "SCREEN_DONE") {
      items.push({
        kind: "review",
        edge_id: edge.edge_id,
        title: edge.title,
        detail: "screen評価結果のレビュー待ち",
        issue_id: null
      });
    }
  }

  for (const issue of dqResult.results ?? []) {
    items.push({
      kind: "dq",
      edge_id: null,
      title: issue.rule_id,
      detail: `${issue.stream_id} (critical, ${new Date(issue.detected_at).toISOString().slice(0, 10)})`,
      issue_id: issue.issue_id
    });
  }

  return items;
}
