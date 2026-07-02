import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEdgeVersionRequestSchema } from "../api/edges.js";

// Parses seeds/0001_pdf_edges.sql's edge_versions INSERTs and validates each
// signal_spec against the same zod schema the API enforces at request time
// (docs/09 §3 P0 seeds must actually satisfy docs/05 §9's DSL grammar).
describe("PDF P0 seed signal_specs (seeds/0001_pdf_edges.sql)", () => {
  const sqlPath = fileURLToPath(new URL("../../../../seeds/0001_pdf_edges.sql", import.meta.url));
  const sql = readFileSync(sqlPath, "utf8");

  const versionInserts = [
    ...sql.matchAll(/INSERT INTO edge_versions[\s\S]*?VALUES \(([\s\S]*?)\);/g)
  ];

  it("found the expected number of P0 edge_versions", () => {
    // docs/09 §3: 4 of the 5 P0 seeds get a tradeable signal_spec; EC-013
    // (VRP) stays observation-only in V1 (see scripts/pdf-edges-data.mjs).
    expect(versionInserts.length).toBe(4);
  });

  it.each(versionInserts.map((m, i) => [i, m[1]] as const))(
    "version #%i has a valid signal_spec + cost_model",
    (_i, valuesBlob) => {
      // Split the SQL value tuple on top-level commas between quoted strings.
      const values = splitSqlValues(valuesBlob as string);
      const [, , semver, signalSpecSql, , instrumentId, direction, horizon, costModelSql] = values;
      const signalSpec = JSON.parse(unquote(signalSpecSql as string));
      const costModel = JSON.parse(unquote(costModelSql as string));

      const parsed = createEdgeVersionRequestSchema.safeParse({
        semver: unquote(semver as string),
        signal_spec: signalSpec,
        params: {},
        instrument_id: unquote(instrumentId as string),
        direction: unquote(direction as string),
        horizon: unquote(horizon as string),
        cost_model: costModel
      });
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  );
});

function unquote(sqlLiteral: string): string {
  const trimmed = sqlLiteral.trim();
  if (!trimmed.startsWith("'")) return trimmed;
  return trimmed.slice(1, -1).replace(/''/g, "'");
}

function splitSqlValues(blob: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < blob.length; i++) {
    const ch = blob[i];
    if (ch === "'" && blob[i + 1] === "'" && inString) {
      current += "''";
      i++;
      continue;
    }
    if (ch === "'") inString = !inString;
    if (!inString && (ch === "(" || ch === "{" || ch === "[")) depth++;
    if (!inString && (ch === ")" || ch === "}" || ch === "]")) depth--;
    if (!inString && depth === 0 && ch === ",") {
      values.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current);
  return values;
}
