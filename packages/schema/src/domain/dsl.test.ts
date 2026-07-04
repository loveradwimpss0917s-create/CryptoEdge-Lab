import { describe, expect, it } from "vitest";
import { referencedEventTypes, referencedFeatures, signalSpecSchema, usesRegime, type BoolExpr } from "./dsl.js";

describe("signal_spec DSL validation (docs/05 §9)", () => {
  it("accepts the usdt-mint-drift seed spec shape", () => {
    const spec = {
      when: { event: { type: "usdt_mint", min_magnitude: 1_000_000_000 } },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "30m" },
      direction: "long"
    };
    expect(signalSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("accepts nested and/or/not with regime and time constraints", () => {
    const spec = {
      when: {
        and: [
          { cmp: [{ feature: "funding_z_90d" }, ">", 2] },
          { not: { regime: { liquidity: ["stressed"] } } },
          { time: { utc_hour_in: [21, 22], dow_in: [1, 2, 3, 4, 5] } }
        ]
      },
      entry: { delay_bars: 1, price: "open" },
      exit: { cond: { cmp: [{ feature: "funding_z_90d" }, "<", 0] }, max_horizon: "72h" },
      direction: "long"
    };
    expect(signalSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects a comparator not in the allowed set", () => {
    const spec = {
      when: { cmp: [{ feature: "x" }, "==", 1] },
      entry: { delay_bars: 1, price: "open" },
      exit: { horizon: "1h" },
      direction: "long"
    };
    expect(signalSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects missing exit", () => {
    const spec = {
      when: { cmp: [{ feature: "x" }, ">", 1] },
      entry: { delay_bars: 1, price: "open" },
      direction: "long"
    };
    expect(signalSpecSchema.safeParse(spec).success).toBe(false);
  });
});

// docs/06 §7.3: these must stay in lockstep with on_demand.py's
// _referenced_features/_referenced_event_types/_uses_regime (2026-07
// Research Readiness).
describe("referencedFeatures", () => {
  it("collects both cmp operands, walking and/or/not", () => {
    const expr: BoolExpr = {
      and: [
        { cmp: [{ feature: "ret_24h" }, ">", { feature: "sma200_dist_pct" }] },
        { not: { cmp: [{ feature: "funding_z_30d" }, "<", 0] } }
      ]
    };
    expect(referencedFeatures(expr)).toEqual(new Set(["ret_24h", "sma200_dist_pct", "funding_z_30d"]));
  });

  it("returns an empty set for event/regime/time nodes", () => {
    const expr: BoolExpr = { event: { type: "usdt_mint" } };
    expect(referencedFeatures(expr)).toEqual(new Set());
  });
});

describe("referencedEventTypes", () => {
  it("collects event types walking or/not", () => {
    const expr: BoolExpr = { or: [{ event: { type: "cme_gap" } }, { not: { event: { type: "usdt_mint" } } }] };
    expect(referencedEventTypes(expr)).toEqual(new Set(["cme_gap", "usdt_mint"]));
  });

  it("returns an empty set when there's no event node", () => {
    expect(referencedEventTypes({ cmp: [{ feature: "x" }, ">", 1] })).toEqual(new Set());
  });
});

describe("usesRegime", () => {
  it("finds a regime node nested under and/or/not", () => {
    const expr: BoolExpr = { and: [{ cmp: [{ feature: "x" }, ">", 1] }, { not: { regime: { trend: ["up"] } } }] };
    expect(usesRegime(expr)).toBe(true);
  });

  it("is false when no regime node is present", () => {
    expect(usesRegime({ cmp: [{ feature: "x" }, ">", 1] })).toBe(false);
  });
});
