import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BoolExpr } from "@cryptoedge/schema";
import { computeFires, type DslEvalInput } from "./dsl-evaluator.js";

interface GoldenVector {
  name: string;
  when: BoolExpr;
  timestamps: number[];
  features: Record<string, (number | null)[]>;
  events: { type: string; magnitude: number }[][];
  regimes: DslEvalInput["regimes"];
  expected_fires: boolean[];
}

const fixturePath = fileURLToPath(
  new URL("../../../../packages/schema/fixtures/dsl-golden.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { vectors: GoldenVector[] };

describe("DSL evaluator golden vectors (docs/11 §4 cross-language contract)", () => {
  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const input: DslEvalInput = {
        timestamps: vector.timestamps,
        features: vector.features,
        events: vector.events,
        regimes: vector.regimes
      };
      expect(computeFires(vector.when, input)).toEqual(vector.expected_fires);
    });
  }
});
