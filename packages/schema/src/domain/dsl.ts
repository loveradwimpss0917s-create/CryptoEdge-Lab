// Signal definition DSL (docs/05 §9). Deliberately not Turing-complete: a
// constrained JSON grammar so the same semantics can be implemented twice
// (Python in research/, TypeScript in workers/ingest) and kept in sync via
// golden-vector contract tests (docs/11 §4). Do not add an "eval string"
// escape hatch here — that would defeat the whole point.

import { z } from "zod";

export const featureRefSchema = z.object({
  feature: z.string().min(1),
  lag: z.number().int().min(0).optional()
});
export type FeatureRef = z.infer<typeof featureRefSchema>;

const comparator = z.enum([">", "<", ">=", "<="]);

const cmpOperandSchema: z.ZodType<number | FeatureRef> = z.union([z.number(), featureRefSchema]);

export interface CmpExpr {
  cmp: [FeatureRef, ">" | "<" | ">=" | "<=", number | FeatureRef];
}

export interface EventExpr {
  event: { type: string; min_magnitude?: number | undefined };
}

export interface RegimeExpr {
  regime: {
    trend?: ("up" | "down" | "range")[] | undefined;
    vol?: ("low" | "high" | "extreme")[] | undefined;
    liquidity?: ("normal" | "stressed")[] | undefined;
  };
}

export interface TimeExpr {
  time: { utc_hour_in?: number[] | undefined; dow_in?: number[] | undefined };
}

export interface AndExpr {
  and: BoolExpr[];
}
export interface OrExpr {
  or: BoolExpr[];
}
export interface NotExpr {
  not: BoolExpr;
}

export type BoolExpr =
  | AndExpr
  | OrExpr
  | NotExpr
  | CmpExpr
  | EventExpr
  | RegimeExpr
  | TimeExpr;

// z.lazy is required because BoolExpr is recursive (and/or/not nest it).
export const boolExprSchema: z.ZodType<BoolExpr> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(boolExprSchema).min(1) }),
    z.object({ or: z.array(boolExprSchema).min(1) }),
    z.object({ not: boolExprSchema }),
    z.object({ cmp: z.tuple([featureRefSchema, comparator, cmpOperandSchema]) }),
    z.object({
      event: z.object({ type: z.string().min(1), min_magnitude: z.number().optional() })
    }),
    z.object({
      regime: z.object({
        trend: z.array(z.enum(["up", "down", "range"])).optional(),
        vol: z.array(z.enum(["low", "high", "extreme"])).optional(),
        liquidity: z.array(z.enum(["normal", "stressed"])).optional()
      })
    }),
    z.object({
      time: z.object({
        utc_hour_in: z.array(z.number().int().min(0).max(23)).optional(),
        dow_in: z.array(z.number().int().min(0).max(6)).optional()
      })
    })
  ])
);

export const signalSpecSchema = z.object({
  when: boolExprSchema,
  entry: z.object({
    delay_bars: z.number().int().min(1).default(1),
    price: z.enum(["open"]).default("open")
  }),
  exit: z.union([
    z.object({ horizon: z.string().min(1) }),
    z.object({ cond: boolExprSchema, max_horizon: z.string().min(1) })
  ]),
  direction: z.enum(["long", "short", "signal_sign"])
});
export type SignalSpec = z.infer<typeof signalSpecSchema>;
