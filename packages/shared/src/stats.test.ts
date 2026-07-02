import { describe, expect, it } from "vitest";
import { emptyMoments, ewmaUpdate, updateMoments, zScore } from "./stats.js";

describe("online moments (Welford) — docs/01 §4.1 CPU-budget constraint", () => {
  it("matches a naive batch mean/stddev computation", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let state = emptyMoments();
    for (const x of xs) state = updateMoments(state, x);

    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance =
      xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1);

    expect(state.mean).toBeCloseTo(mean, 10);
    expect(state.m2 / (state.n - 1)).toBeCloseTo(variance, 10);
  });

  it("returns z-score 0 before variance is defined", () => {
    const state = updateMoments(emptyMoments(), 5);
    expect(zScore(state, 5)).toBe(0);
  });

  it("ewmaUpdate seeds on first observation and blends thereafter", () => {
    expect(ewmaUpdate(null, 10, 0.5)).toBe(10);
    expect(ewmaUpdate(10, 20, 0.5)).toBe(15);
  });
});
