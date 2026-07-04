// Research Readiness (docs/06 §7, 2026-07 design): an axis orthogonal to
// the lifecycle state machine (domain/edge-lifecycle.ts). Lifecycle asks
// "how far has this Edge gotten"; readiness asks "what kind of work does
// it need *today*" -- promotes docs/14's static A/B/C/D classification
// into a live, auto-computed state.
//
// computeReadiness is a pure function: apps/api gathers the inputs from
// D1 (edges/edge_versions/eval_runs/feature_defs/base-data presence/
// events/regimes_daily), this module only decides the state from them.
// Evaluated top-down (first match wins), exactly the order docs/06 §7.2
// specifies.

import type { EdgeReadinessClass } from "../db/enums.js";
import type { EdgeStatus } from "../db/enums.js";

export const READINESS_STATES = [
  "VALIDATED_PLUS",
  "FULL_DONE",
  "SCREEN_DONE",
  "READY",
  "DATA_PENDING",
  "FEATURE_PENDING",
  "SIGNAL_SPEC_PENDING",
  "BUILD_PENDING"
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export interface MissingElements {
  signalSpec?: boolean;
  feature?: string[];
  data?: string[];
  event?: string[];
  build?: string[];
}

export interface ReadinessInput {
  status: EdgeStatus;
  hasCurrentVersion: boolean;
  hasScreenRunDone: boolean;
  hasFullRunDone: boolean;
  /** Feature names the current version's signal_spec references but that
   * have no `feature_defs` row at all (docs/06 §7.3 FEATURE待ち). */
  undefinedFeatures: string[];
  /** Feature names that *are* registered in `feature_defs` but whose
   * underlying base data table has no rows yet (docs/06 §7.3 DATA待ち --
   * the ls_top_trader_z_30d / long_short_ratios case found in Edge Pack
   * v1 Phase 1). */
  dataPendingFeatures: string[];
  /** Referenced event types with zero rows in `events`. */
  dataPendingEvents: string[];
  usesRegimeCondition: boolean;
  hasAnyRegimeData: boolean;
  /** docs/14 §2 classification, only consulted when hasCurrentVersion is
   * false. Null defaults to SIGNAL_SPEC_PENDING (optimistic). */
  planClass: EdgeReadinessClass | null;
  /** Free-text missing-implementation items (docs/14 "build" column),
   * only used for BUILD_PENDING. */
  planBlockers: string[];
}

export interface ReadinessResult {
  state: ReadinessState;
  missing: MissingElements;
}

const LIFECYCLE_PAST_TESTING: ReadonlySet<EdgeStatus> = new Set([
  "VALIDATED",
  "PAPER",
  "ACTIVE",
  "DECAYING"
]);

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  if (LIFECYCLE_PAST_TESTING.has(input.status)) {
    return { state: "VALIDATED_PLUS", missing: {} };
  }
  if (input.hasFullRunDone) {
    return { state: "FULL_DONE", missing: {} };
  }
  if (input.hasScreenRunDone) {
    return { state: "SCREEN_DONE", missing: {} };
  }

  if (input.hasCurrentVersion) {
    const dataMissing = [...input.dataPendingFeatures];
    const eventMissing = [...input.dataPendingEvents];
    const regimeDataMissing = input.usesRegimeCondition && !input.hasAnyRegimeData;

    if (dataMissing.length > 0 || eventMissing.length > 0 || regimeDataMissing) {
      const missing: MissingElements = {};
      if (dataMissing.length > 0) missing.data = dataMissing;
      if (eventMissing.length > 0) missing.event = eventMissing;
      if (regimeDataMissing) missing.data = [...(missing.data ?? []), "regimes_daily"];
      return { state: "DATA_PENDING", missing };
    }

    if (input.undefinedFeatures.length > 0) {
      return { state: "FEATURE_PENDING", missing: { feature: [...input.undefinedFeatures] } };
    }

    return { state: "READY", missing: {} };
  }

  // No current version: fall back to the docs/14 plan classification.
  if (input.planClass === "C" || input.planClass === "D") {
    return { state: "BUILD_PENDING", missing: { build: [...input.planBlockers] } };
  }
  // "A", "B", or unclassified (null) -> assume a signal_spec is writable.
  return { state: "SIGNAL_SPEC_PENDING", missing: { signalSpec: true } };
}
