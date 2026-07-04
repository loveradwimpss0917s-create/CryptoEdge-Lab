// Research Readiness (docs/06 §7, 2026-07 design): gathers the D1 inputs
// computeReadiness (packages/schema) needs and runs it per edge. Single
// place both GET /edges (list) and GET /edges/:id (detail) call into, so
// the two surfaces can never compute readiness differently.

import {
  computeReadiness,
  referencedEventTypes,
  referencedFeatures,
  signalSpecSchema,
  usesRegime,
  type EdgeReadinessClass,
  type EdgeStatus,
  type ReadinessResult
} from "@cryptoedge/schema";
import type { Env } from "../env.js";

export interface EdgeReadinessInputRow {
  edge_id: string;
  status: EdgeStatus;
  readiness_class: EdgeReadinessClass | null;
  readiness_blockers: string | null; // JSON string[]
}

// Only deriv-family features can be DATA_PENDING today -- price-family
// features are backed by R2 candle history, which every instrument this
// project tracks already has (docs/04 §3.3). This mirrors
// research/.../features/registry.py's deriv FeatureDefs 1:1; a new deriv
// feature added there needs a matching entry here (2026-07 review: no
// single source of truth for this exists yet across Python/TS, tracked as
// a follow-up rather than blocking Research Readiness v1 on it).
const DERIV_FEATURE_BASE_TABLE: Record<string, string> = {
  funding_z_30d: "funding_rates",
  funding_chg_24h: "funding_rates",
  oi_chg_24h: "open_interest",
  oi_pctile_1y: "open_interest",
  ls_all_account_z_30d: "long_short_ratios",
  ls_top_trader_z_30d: "long_short_ratios",
  liq_notional_24h: "liquidations_5m"
};

interface SharedReadinessContext {
  definedFeatures: Set<string>;
  tableHasData: Record<string, boolean>;
  eventTypesWithData: Set<string>;
  hasAnyRegimeData: boolean;
}

async function loadSharedContext(env: Env): Promise<SharedReadinessContext> {
  const [featureDefs, funding, oi, ls, liq, events, regimes] = await Promise.all([
    env.DB.prepare(`SELECT feature_id FROM feature_defs WHERE status = 'active'`).all<{ feature_id: string }>(),
    env.DB.prepare(`SELECT 1 FROM funding_rates LIMIT 1`).first(),
    env.DB.prepare(`SELECT 1 FROM open_interest LIMIT 1`).first(),
    env.DB.prepare(`SELECT 1 FROM long_short_ratios LIMIT 1`).first(),
    env.DB.prepare(`SELECT 1 FROM liquidations_5m LIMIT 1`).first(),
    env.DB.prepare(`SELECT DISTINCT event_type FROM events`).all<{ event_type: string }>(),
    env.DB.prepare(`SELECT 1 FROM regimes_daily LIMIT 1`).first()
  ]);

  // feature_defs.feature_id is "{feature_set_version}.{name}" (docs/04 §3.1,
  // e.g. "v1.ret_24h"); signal_spec references the bare name.
  const definedFeatures = new Set(
    (featureDefs.results ?? []).map((r) => r.feature_id.split(".").slice(1).join("."))
  );

  return {
    definedFeatures,
    tableHasData: {
      funding_rates: funding !== null,
      open_interest: oi !== null,
      long_short_ratios: ls !== null,
      liquidations_5m: liq !== null
    },
    eventTypesWithData: new Set((events.results ?? []).map((r) => r.event_type)),
    hasAnyRegimeData: regimes !== null
  };
}

interface CurrentVersionRow {
  edge_id: string;
  version_id: string;
  signal_spec: string;
}

interface DoneRunRow {
  edge_version_id: string;
  run_kind: string;
}

export async function computeReadinessForEdges(
  env: Env,
  edges: EdgeReadinessInputRow[]
): Promise<Map<string, ReadinessResult>> {
  const result = new Map<string, ReadinessResult>();
  if (edges.length === 0) return result;

  const edgeIds = edges.map((e) => e.edge_id);
  const placeholders = edgeIds.map((_, i) => `?${i + 1}`).join(",");

  const [ctx, versionsRes] = await Promise.all([
    loadSharedContext(env),
    env.DB.prepare(
      `SELECT edge_id, version_id, signal_spec FROM edge_versions WHERE edge_id IN (${placeholders}) AND is_current = 1`
    )
      .bind(...edgeIds)
      .all<CurrentVersionRow>()
  ]);

  const versionByEdge = new Map((versionsRes.results ?? []).map((v) => [v.edge_id, v]));
  const versionIds = [...versionByEdge.values()].map((v) => v.version_id);

  const doneRunKindsByVersion = new Map<string, Set<string>>();
  if (versionIds.length > 0) {
    const versionPlaceholders = versionIds.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await env.DB.prepare(
      `SELECT edge_version_id, run_kind FROM eval_runs WHERE edge_version_id IN (${versionPlaceholders}) AND status = 'done'`
    )
      .bind(...versionIds)
      .all<DoneRunRow>();
    for (const row of results ?? []) {
      const set = doneRunKindsByVersion.get(row.edge_version_id) ?? new Set<string>();
      set.add(row.run_kind);
      doneRunKindsByVersion.set(row.edge_version_id, set);
    }
  }

  for (const edge of edges) {
    const version = versionByEdge.get(edge.edge_id);
    const doneKinds = version ? (doneRunKindsByVersion.get(version.version_id) ?? new Set<string>()) : new Set<string>();

    if (!version) {
      const planBlockers: string[] = edge.readiness_blockers ? JSON.parse(edge.readiness_blockers) : [];
      result.set(
        edge.edge_id,
        computeReadiness({
          status: edge.status,
          hasCurrentVersion: false,
          hasScreenRunDone: false,
          hasFullRunDone: false,
          undefinedFeatures: [],
          dataPendingFeatures: [],
          dataPendingEvents: [],
          usesRegimeCondition: false,
          hasAnyRegimeData: ctx.hasAnyRegimeData,
          planClass: edge.readiness_class,
          planBlockers
        })
      );
      continue;
    }

    const spec = signalSpecSchema.parse(JSON.parse(version.signal_spec));
    const features = [...referencedFeatures(spec.when)];
    const eventTypes = [...referencedEventTypes(spec.when)];
    const undefinedFeatures = features.filter((f) => !ctx.definedFeatures.has(f));
    const dataPendingFeatures = features.filter((f) => {
      const table = DERIV_FEATURE_BASE_TABLE[f];
      return table !== undefined && ctx.definedFeatures.has(f) && !ctx.tableHasData[table];
    });
    const dataPendingEvents = eventTypes.filter((t) => !ctx.eventTypesWithData.has(t));

    result.set(
      edge.edge_id,
      computeReadiness({
        status: edge.status,
        hasCurrentVersion: true,
        hasScreenRunDone: doneKinds.has("screen"),
        hasFullRunDone: doneKinds.has("full"),
        undefinedFeatures,
        dataPendingFeatures,
        dataPendingEvents,
        usesRegimeCondition: usesRegime(spec.when),
        hasAnyRegimeData: ctx.hasAnyRegimeData,
        planClass: edge.readiness_class,
        planBlockers: []
      })
    );
  }

  return result;
}
