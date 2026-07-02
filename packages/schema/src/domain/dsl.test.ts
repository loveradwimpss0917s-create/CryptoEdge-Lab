import { describe, expect, it } from "vitest";
import { signalSpecSchema } from "./dsl.js";

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
