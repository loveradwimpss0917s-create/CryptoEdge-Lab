import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkQuotaThresholds } from "./quota-alert.js";
import type { Env } from "../env.js";

interface QuotaRow {
  resource: string;
  value: number;
  budget: number;
}

/** Minimal env.DB stand-in: routes by a substring of the SQL text to one of
 * three canned behaviors this module actually issues (select quota_usage,
 * select dq_issues existence, insert dq_issues via recordDqIssue). */
function fakeEnv(quotaRows: QuotaRow[], alreadyWarnedStreamIds: Set<string>) {
  const inserted: unknown[] = [];
  const prepare = vi.fn((sql: string) => {
    if (sql.includes("FROM quota_usage")) {
      return { bind: () => ({ all: async () => ({ results: quotaRows }) }) };
    }
    if (sql.includes("FROM dq_issues")) {
      return {
        bind: (streamId: string) => ({
          first: async () => (alreadyWarnedStreamIds.has(streamId) ? { 1: 1 } : null)
        })
      };
    }
    if (sql.includes("INSERT INTO dq_issues")) {
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            inserted.push(args);
          }
        })
      };
    }
    throw new Error(`unexpected SQL in test double: ${sql}`);
  });
  const env = { DB: { prepare } } as unknown as Env;
  return { env, inserted };
}

describe("checkQuotaThresholds (DQ-10, 2026-07 review Task 7)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does nothing below the 80% threshold", async () => {
    const { env, inserted } = fakeEnv([{ resource: "d1_writes", value: 50_000, budget: 100_000 }], new Set());
    await checkQuotaThresholds(env);
    expect(inserted).toHaveLength(0);
  });

  it("records a DQ-10 issue once a resource crosses 80%", async () => {
    const { env, inserted } = fakeEnv([{ resource: "d1_writes", value: 85_000, budget: 100_000 }], new Set());
    await checkQuotaThresholds(env);
    expect(inserted).toHaveLength(1);
  });

  it("does not duplicate an issue already recorded today for the same resource", async () => {
    const { env, inserted } = fakeEnv(
      [{ resource: "d1_writes", value: 90_000, budget: 100_000 }],
      new Set([`quota:d1_writes:${new Date().toISOString().slice(0, 10)}`])
    );
    await checkQuotaThresholds(env);
    expect(inserted).toHaveLength(0);
  });

  it("ignores resources with no fixed budget (Infinity)", async () => {
    const { env, inserted } = fakeEnv(
      [{ resource: "unbounded_thing", value: 999, budget: Number.POSITIVE_INFINITY }],
      new Set()
    );
    await checkQuotaThresholds(env);
    expect(inserted).toHaveLength(0);
  });

  it("notifies Telegram when configured, alongside recording the issue", async () => {
    const { env, inserted } = fakeEnv([{ resource: "d1_writes", value: 85_000, budget: 100_000 }], new Set());
    (env as unknown as { TELEGRAM_BOT_TOKEN: string }).TELEGRAM_BOT_TOKEN = "token";
    (env as unknown as { TELEGRAM_CHAT_ID: string }).TELEGRAM_CHAT_ID = "chat";

    await checkQuotaThresholds(env);

    expect(inserted).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("api.telegram.org"),
      expect.objectContaining({ method: "POST" })
    );
  });
});
