import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "./test-utils/fake-d1.js";
import { recordDqIssue, touchIngestState } from "./db.js";
import type { Env } from "./env.js";

let fake: FakeD1;
let env: Env;

beforeEach(() => {
  fake = new FakeD1();
  env = { DB: fake as unknown as D1Database } as Env;
});

afterEach(() => {
  fake.close();
});

interface DqIssueRow {
  status: string;
  resolved_at: number | null;
}

describe("touchIngestState (docs/19 S-02: auto-resolve dq_issues on stream recovery)", () => {
  it("closes open dq_issues for the stream when it succeeds", async () => {
    await recordDqIssue(env, { streamId: "s1", ruleId: "DQ-02", severity: "critical" });
    await touchIngestState(env, "s1", 1000, "ok");

    const rows = (await env.DB.prepare(`SELECT status, resolved_at FROM dq_issues WHERE stream_id = 's1'`).all<DqIssueRow>())
      .results!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("resolved");
    expect(rows[0]!.resolved_at).not.toBeNull();
  });

  it("does not touch other streams' open issues", async () => {
    await recordDqIssue(env, { streamId: "s1", ruleId: "DQ-02", severity: "critical" });
    await recordDqIssue(env, { streamId: "s2", ruleId: "DQ-02", severity: "critical" });
    await touchIngestState(env, "s1", 1000, "ok");

    const s2 = (await env.DB.prepare(`SELECT status, resolved_at FROM dq_issues WHERE stream_id = 's2'`).all<DqIssueRow>())
      .results!;
    expect(s2[0]!.status).toBe("open");
    expect(s2[0]!.resolved_at).toBeNull();
  });

  it("leaves already-resolved issues alone (does not overwrite resolved_at)", async () => {
    await recordDqIssue(env, { streamId: "s1", ruleId: "DQ-02", severity: "critical" });
    await touchIngestState(env, "s1", 1000, "ok");
    const firstResolvedAt = (
      await env.DB.prepare(`SELECT resolved_at FROM dq_issues WHERE stream_id = 's1'`).all<DqIssueRow>()
    ).results![0]!.resolved_at;

    await touchIngestState(env, "s1", 2000, "ok");
    const secondResolvedAt = (
      await env.DB.prepare(`SELECT resolved_at FROM dq_issues WHERE stream_id = 's1'`).all<DqIssueRow>()
    ).results![0]!.resolved_at;

    expect(secondResolvedAt).toBe(firstResolvedAt);
  });
});
