import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { FakeD1 } from "../test-utils/fake-d1.js";
import { opsRoute } from "./ops.js";
import type { Env } from "../env.js";

let fake: FakeD1;
let env: Env;

beforeEach(() => {
  fake = new FakeD1();
  env = { DB: fake as unknown as D1Database } as Env;
});

afterEach(() => {
  fake.close();
});

describe("GET /ops/quota", () => {
  it("returns an empty list when nothing has been recorded today", async () => {
    const res = await opsRoute.request("/quota", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dt: string; quota: unknown[] };
    expect(body.quota).toEqual([]);
  });

  it("computes usage_ratio from value/budget and passes null through for unbounded resources", async () => {
    const dt = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(`INSERT INTO quota_usage (dt, resource, value, budget) VALUES (?1, 'd1_writes', 80000, 100000)`)
      .bind(dt)
      .run();
    await env.DB.prepare(`INSERT INTO quota_usage (dt, resource, value, budget) VALUES (?1, 'unbounded_thing', 5, ?2)`)
      .bind(dt, Number.POSITIVE_INFINITY)
      .run();

    const res = await opsRoute.request("/quota", {}, env);
    const body = (await res.json()) as {
      quota: { resource: string; value: number; budget: number; usage_ratio: number | null }[]
    };
    const d1 = body.quota.find((q) => q.resource === "d1_writes")!;
    expect(d1.usage_ratio).toBeCloseTo(0.8);
    const unbounded = body.quota.find((q) => q.resource === "unbounded_thing")!;
    expect(unbounded.usage_ratio).toBeNull();
  });
});
