import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database, R2Bucket, R2ObjectBody } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { packsRoute } from "./packs.js";
import type { Env } from "../env.js";

// Minimal in-memory R2 fake: packs.ts only ever calls `.get(key)` and reads
// the result's `.text()`, so that's all this needs to implement.
class FakeR2 {
  private readonly objects = new Map<string, string>();

  put(key: string, value: string): void {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return { text: async () => value } as R2ObjectBody;
  }
}

let fake: FakeD1;
let lake: FakeR2;
let env: Env;

beforeEach(() => {
  fake = new FakeD1();
  lake = new FakeR2();
  env = { DB: fake as unknown as D1Database, LAKE: lake as unknown as R2Bucket } as Env;
});

afterEach(() => {
  fake.close();
});

describe("GET /packs/:kind/latest (docs/15 SONNET-2)", () => {
  it("rejects an unknown pack kind", async () => {
    const res = await packsRoute.request("/not-a-kind/latest", {}, env);
    expect(res.status).toBe(400);
  });

  it("404s when no pack of that kind has ever been generated", async () => {
    const res = await packsRoute.request("/briefing/latest", {}, env);
    expect(res.status).toBe(404);
  });

  it("returns the most recent ai_outputs row's R2 content", async () => {
    lake.put("packs/briefing/2026-07-03.md", "# stale");
    lake.put("packs/briefing/2026-07-04.md", "# today's briefing");
    await env.DB.prepare(
      `INSERT INTO ai_outputs (output_id, kind, ref_date, model, prompt_version, content_ref, status, created_at)
       VALUES ('o1', 'briefing', '2026-07-03', 'template', 'daily_briefing-1.0', 'packs/briefing/2026-07-03.md', 'draft', 100)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO ai_outputs (output_id, kind, ref_date, model, prompt_version, content_ref, status, created_at)
       VALUES ('o2', 'briefing', '2026-07-04', 'template', 'daily_briefing-1.0', 'packs/briefing/2026-07-04.md', 'draft', 200)`
    ).run();

    const res = await packsRoute.request("/briefing/latest", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref_date: string; content: string };
    expect(body.ref_date).toBe("2026-07-04");
    expect(body.content).toBe("# today's briefing");
  });

  it("404s if the ai_outputs row exists but its R2 object is missing", async () => {
    await env.DB.prepare(
      `INSERT INTO ai_outputs (output_id, kind, ref_date, model, prompt_version, content_ref, status, created_at)
       VALUES ('o1', 'briefing', '2026-07-04', 'template', 'daily_briefing-1.0', 'packs/briefing/missing.md', 'draft', 100)`
    ).run();
    const res = await packsRoute.request("/briefing/latest", {}, env);
    expect(res.status).toBe(404);
  });
});
