import { describe, expect, it, vi } from "vitest";
import { checkAndEscalate } from "./consecutive-errors.js";
import type { Env } from "../env.js";

function fakeEnv(): { env: Env; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => undefined);
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  const env = { DB: { prepare } } as unknown as Env;
  return { env, run };
}

describe("checkAndEscalate (DQ-02, 2026-07 review Task 6)", () => {
  it("escalates a non-rate-limit error at the default threshold of 3", async () => {
    const { env, run } = fakeEnv();
    await checkAndEscalate(env, "s1", 2, "some 500 error");
    expect(run).not.toHaveBeenCalled();
    await checkAndEscalate(env, "s1", 3, "some 500 error");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not escalate an HTTP 429 error at the default threshold of 3", async () => {
    const { env, run } = fakeEnv();
    await checkAndEscalate(env, "s1", 3, "https://x -> HTTP 429 (after 429 retry)");
    expect(run).not.toHaveBeenCalled();
  });

  it("escalates an HTTP 429 error only once it reaches the relaxed threshold of 6", async () => {
    const { env, run } = fakeEnv();
    await checkAndEscalate(env, "s1", 5, "https://x -> HTTP 429 (after 429 retry)");
    expect(run).not.toHaveBeenCalled();
    await checkAndEscalate(env, "s1", 6, "https://x -> HTTP 429 (after 429 retry)");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("only fires once per streak, not on every tick past the threshold", async () => {
    const { env, run } = fakeEnv();
    await checkAndEscalate(env, "s1", 3, "boom");
    await checkAndEscalate(env, "s1", 4, "boom");
    await checkAndEscalate(env, "s1", 5, "boom");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
