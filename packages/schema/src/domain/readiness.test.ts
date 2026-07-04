import { describe, expect, it } from "vitest";
import { computeReadiness, type ReadinessInput } from "./readiness.js";

const BASE: ReadinessInput = {
  status: "IDEA",
  hasCurrentVersion: false,
  hasScreenRunDone: false,
  hasFullRunDone: false,
  undefinedFeatures: [],
  dataPendingFeatures: [],
  dataPendingEvents: [],
  usesRegimeCondition: false,
  hasAnyRegimeData: true,
  planClass: null,
  planBlockers: []
};

describe("computeReadiness", () => {
  it("returns VALIDATED_PLUS once lifecycle is past TESTING, regardless of other inputs", () => {
    for (const status of ["VALIDATED", "PAPER", "ACTIVE", "DECAYING"] as const) {
      expect(computeReadiness({ ...BASE, status, hasCurrentVersion: true }).state).toBe("VALIDATED_PLUS");
    }
  });

  it("returns FULL_DONE when a full run is done, even if lifecycle hasn't advanced yet", () => {
    const result = computeReadiness({ ...BASE, hasCurrentVersion: true, hasFullRunDone: true });
    expect(result).toEqual({ state: "FULL_DONE", missing: {} });
  });

  it("returns SCREEN_DONE when only a screen run is done", () => {
    const result = computeReadiness({ ...BASE, hasCurrentVersion: true, hasScreenRunDone: true });
    expect(result).toEqual({ state: "SCREEN_DONE", missing: {} });
  });

  it("returns READY when a version exists and every dependency is satisfied", () => {
    const result = computeReadiness({ ...BASE, hasCurrentVersion: true });
    expect(result).toEqual({ state: "READY", missing: {} });
  });

  it("returns DATA_PENDING when a registered feature's underlying data is empty (the ls_top_trader_z_30d case)", () => {
    const result = computeReadiness({
      ...BASE,
      hasCurrentVersion: true,
      dataPendingFeatures: ["ls_top_trader_z_30d"]
    });
    expect(result).toEqual({ state: "DATA_PENDING", missing: { data: ["ls_top_trader_z_30d"] } });
  });

  it("returns DATA_PENDING when a referenced event type has no rows", () => {
    const result = computeReadiness({ ...BASE, hasCurrentVersion: true, dataPendingEvents: ["fomc"] });
    expect(result).toEqual({ state: "DATA_PENDING", missing: { event: ["fomc"] } });
  });

  it("returns DATA_PENDING when a regime condition is used but regimes_daily is empty", () => {
    const result = computeReadiness({
      ...BASE,
      hasCurrentVersion: true,
      usesRegimeCondition: true,
      hasAnyRegimeData: false
    });
    expect(result).toEqual({ state: "DATA_PENDING", missing: { data: ["regimes_daily"] } });
  });

  it("returns FEATURE_PENDING when a referenced feature has no feature_defs row (data-pending takes priority when both apply)", () => {
    const result = computeReadiness({
      ...BASE,
      hasCurrentVersion: true,
      undefinedFeatures: ["some_new_feature"]
    });
    expect(result).toEqual({ state: "FEATURE_PENDING", missing: { feature: ["some_new_feature"] } });
  });

  it("prioritizes DATA_PENDING over FEATURE_PENDING when both are present", () => {
    const result = computeReadiness({
      ...BASE,
      hasCurrentVersion: true,
      dataPendingFeatures: ["ls_top_trader_z_30d"],
      undefinedFeatures: ["some_new_feature"]
    });
    expect(result.state).toBe("DATA_PENDING");
  });

  it("returns SIGNAL_SPEC_PENDING when no version exists and planClass is A or B", () => {
    expect(computeReadiness({ ...BASE, planClass: "A" }).state).toBe("SIGNAL_SPEC_PENDING");
    expect(computeReadiness({ ...BASE, planClass: "B" }).state).toBe("SIGNAL_SPEC_PENDING");
  });

  it("defaults to SIGNAL_SPEC_PENDING when no version exists and planClass is unclassified", () => {
    const result = computeReadiness({ ...BASE, planClass: null });
    expect(result).toEqual({ state: "SIGNAL_SPEC_PENDING", missing: { signalSpec: true } });
  });

  it("returns BUILD_PENDING when no version exists and planClass is C or D, carrying the plan blockers", () => {
    const result = computeReadiness({
      ...BASE,
      planClass: "C",
      planBlockers: ["Coinbase価格データ"]
    });
    expect(result).toEqual({ state: "BUILD_PENDING", missing: { build: ["Coinbase価格データ"] } });
  });
});
