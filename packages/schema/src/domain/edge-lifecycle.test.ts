import { describe, expect, it } from "vitest";
import { canTransition } from "./edge-lifecycle.js";

describe("edge lifecycle guards (docs/05 §2)", () => {
  it("rejects IDEA -> CANDIDATE without counter_evidence", () => {
    const result = canTransition("IDEA", "CANDIDATE", {
      IDEA_to_CANDIDATE: {
        hypothesis: "x",
        rationale: "y",
        counterEvidence: "",
        hasVersion: true
      }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/counter_evidence/);
  });

  it("allows IDEA -> CANDIDATE with complete thesis", () => {
    const result = canTransition("IDEA", "CANDIDATE", {
      IDEA_to_CANDIDATE: {
        hypothesis: "x",
        rationale: "y",
        counterEvidence: "z",
        hasVersion: true
      }
    });
    expect(result.ok).toBe(true);
  });

  it("rejects CANDIDATE -> TESTING when screen p_perm too high", () => {
    const result = canTransition("CANDIDATE", "TESTING", {
      CANDIDATE_to_TESTING: { screenRunEvBps: 5, screenRunPPerm: 0.25 }
    });
    expect(result.ok).toBe(false);
  });

  it("allows TESTING -> VALIDATED only on ADOPT verdict", () => {
    expect(
      canTransition("TESTING", "VALIDATED", {
        TESTING_to_VALIDATED: { fullRunVerdict: "WATCH" }
      }).ok
    ).toBe(false);
    expect(
      canTransition("TESTING", "VALIDATED", {
        TESTING_to_VALIDATED: { fullRunVerdict: "ADOPT" }
      }).ok
    ).toBe(true);
  });

  it("enforces all four PAPER -> ACTIVE conditions", () => {
    const base = {
      paperDays: 31,
      signalCount: 12,
      paperSharpe: 1.1,
      oosSharpeCi95Lo: 0.8,
      oosSharpeCi95Hi: 1.5,
      avgSlippageBps: 2,
      expectedCostBps: 6
    };
    expect(canTransition("PAPER", "ACTIVE", { PAPER_to_ACTIVE: base }).ok).toBe(true);
    expect(
      canTransition("PAPER", "ACTIVE", {
        PAPER_to_ACTIVE: { ...base, paperDays: 10 }
      }).ok
    ).toBe(false);
    expect(
      canTransition("PAPER", "ACTIVE", {
        PAPER_to_ACTIVE: { ...base, paperSharpe: 0.1 }
      }).ok
    ).toBe(false);
    expect(
      canTransition("PAPER", "ACTIVE", {
        PAPER_to_ACTIVE: { ...base, avgSlippageBps: 99 }
      }).ok
    ).toBe(false);
  });

  it("does not reject paper Sharpe above the OOS CI upper bound (one-sided gate, 2026-07 review H-4)", () => {
    const base = {
      paperDays: 31,
      signalCount: 12,
      paperSharpe: 5,
      oosSharpeCi95Lo: 0.8,
      oosSharpeCi95Hi: 1.5,
      avgSlippageBps: 2,
      expectedCostBps: 6
    };
    expect(canTransition("PAPER", "ACTIVE", { PAPER_to_ACTIVE: base }).ok).toBe(true);
  });

  it("rejects transitions outside the graph", () => {
    const result = canTransition("IDEA", "ACTIVE", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not in the transition graph/);
  });

  it("REJECTED is reachable from any state given a REJECT verdict or user decision", () => {
    expect(
      canTransition("CANDIDATE", "REJECTED", {
        any_to_REJECTED: { userInitiated: true }
      }).ok
    ).toBe(true);
    expect(canTransition("CANDIDATE", "REJECTED", { any_to_REJECTED: {} }).ok).toBe(false);
  });
});
