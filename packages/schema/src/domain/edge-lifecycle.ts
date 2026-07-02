// Edge lifecycle state machine (docs/05 §2). This is the single
// implementation of the transition graph and its guard conditions; the API
// service layer (apps/api/src/services/edge-lifecycle.ts) must call into
// this rather than re-encoding the rules.

import type { EdgeStatus } from "../db/enums.js";

/** Adjacency map used for UI (e.g. rendering allowed next states on the Board). */
export const EDGE_TRANSITION_GRAPH: Record<EdgeStatus, EdgeStatus[]> = {
  IDEA: ["CANDIDATE"],
  CANDIDATE: ["TESTING", "REJECTED"],
  TESTING: ["VALIDATED", "CANDIDATE", "REJECTED"],
  VALIDATED: ["PAPER", "REJECTED"],
  PAPER: ["ACTIVE", "RETIRED"],
  ACTIVE: ["DECAYING", "RETIRED"],
  DECAYING: ["ACTIVE", "RETIRED"],
  RETIRED: ["CANDIDATE"],
  REJECTED: ["CANDIDATE"]
};

export interface GuardContext {
  IDEA_to_CANDIDATE?: {
    hypothesis: string;
    rationale: string;
    counterEvidence: string | null;
    hasVersion: boolean;
  };
  CANDIDATE_to_TESTING?: {
    screenRunEvBps: number;
    screenRunPPerm: number;
  };
  TESTING_to_VALIDATED?: {
    fullRunVerdict: "ADOPT" | "WATCH" | "REJECT";
  };
  PAPER_to_ACTIVE?: {
    paperDays: number;
    signalCount: number;
    paperSharpe: number;
    oosSharpeCi95Lo: number;
    oosSharpeCi95Hi: number;
    avgSlippageBps: number;
    expectedCostBps: number;
  };
  ACTIVE_to_DECAYING?: {
    cusumAlarm: boolean;
  };
  any_to_REJECTED?: {
    fullRunVerdict?: "ADOPT" | "WATCH" | "REJECT";
    userInitiated?: boolean;
  };
}

export interface GuardResult {
  ok: boolean;
  reason: string;
}

function guardIdeaToCandidate(ctx: GuardContext["IDEA_to_CANDIDATE"]): GuardResult {
  if (!ctx) return { ok: false, reason: "missing guard context" };
  if (!ctx.hypothesis.trim()) return { ok: false, reason: "hypothesis is required" };
  if (!ctx.rationale.trim()) return { ok: false, reason: "rationale is required" };
  if (!ctx.counterEvidence?.trim())
    return { ok: false, reason: "counter_evidence is required" };
  if (!ctx.hasVersion) return { ok: false, reason: "edge_version v1 must exist" };
  return { ok: true, reason: "thesis complete" };
}

function guardCandidateToTesting(ctx: GuardContext["CANDIDATE_to_TESTING"]): GuardResult {
  if (!ctx) return { ok: false, reason: "missing guard context" };
  if (!(ctx.screenRunEvBps > 0))
    return { ok: false, reason: `screen ev_bps ${ctx.screenRunEvBps} <= 0` };
  if (!(ctx.screenRunPPerm < 0.2))
    return { ok: false, reason: `screen p_perm ${ctx.screenRunPPerm} >= 0.20` };
  return { ok: true, reason: "screen run passed" };
}

function guardTestingToValidated(ctx: GuardContext["TESTING_to_VALIDATED"]): GuardResult {
  if (!ctx) return { ok: false, reason: "missing guard context" };
  if (ctx.fullRunVerdict !== "ADOPT")
    return { ok: false, reason: `full run verdict is ${ctx.fullRunVerdict}, not ADOPT` };
  return { ok: true, reason: "full run ADOPT" };
}

function guardPaperToActive(ctx: GuardContext["PAPER_to_ACTIVE"]): GuardResult {
  if (!ctx) return { ok: false, reason: "missing guard context" };
  if (ctx.paperDays < 30) return { ok: false, reason: `paper period ${ctx.paperDays}d < 30d` };
  if (ctx.signalCount < 10)
    return { ok: false, reason: `signal count ${ctx.signalCount} < 10` };
  if (!(ctx.paperSharpe >= ctx.oosSharpeCi95Lo && ctx.paperSharpe <= ctx.oosSharpeCi95Hi))
    return {
      ok: false,
      reason: `paper sharpe ${ctx.paperSharpe} outside OOS 95% CI [${ctx.oosSharpeCi95Lo}, ${ctx.oosSharpeCi95Hi}]`
    };
  if (ctx.avgSlippageBps > ctx.expectedCostBps)
    return {
      ok: false,
      reason: `avg slippage ${ctx.avgSlippageBps}bps > expected cost ${ctx.expectedCostBps}bps`
    };
  return { ok: true, reason: "paper trading confirms OOS expectations" };
}

function guardActiveToDecaying(ctx: GuardContext["ACTIVE_to_DECAYING"]): GuardResult {
  if (!ctx) return { ok: false, reason: "missing guard context" };
  if (!ctx.cusumAlarm) return { ok: false, reason: "no CUSUM alarm" };
  return { ok: true, reason: "CUSUM alarm triggered" };
}

function guardToRejected(ctx: GuardContext["any_to_REJECTED"]): GuardResult {
  if (!ctx) return { ok: false, reason: "missing guard context" };
  if (ctx.fullRunVerdict === "REJECT") return { ok: true, reason: "full run REJECT" };
  if (ctx.userInitiated) return { ok: true, reason: "user decision" };
  return { ok: false, reason: "neither a REJECT verdict nor a user decision" };
}

/**
 * Evaluate whether `from -> to` is a legal transition given the supplied
 * guard context. Callers (apps/api) are responsible for gathering the
 * context fields relevant to the specific edge being transitioned.
 */
export function canTransition(
  from: EdgeStatus,
  to: EdgeStatus,
  ctx: GuardContext
): GuardResult {
  const allowedTargets = EDGE_TRANSITION_GRAPH[from];
  if (!allowedTargets.includes(to)) {
    return { ok: false, reason: `${from} -> ${to} is not in the transition graph` };
  }

  if (to === "REJECTED") return guardToRejected(ctx.any_to_REJECTED);

  switch (`${from}_to_${to}`) {
    case "IDEA_to_CANDIDATE":
      return guardIdeaToCandidate(ctx.IDEA_to_CANDIDATE);
    case "CANDIDATE_to_TESTING":
      return guardCandidateToTesting(ctx.CANDIDATE_to_TESTING);
    case "TESTING_to_VALIDATED":
      return guardTestingToValidated(ctx.TESTING_to_VALIDATED);
    case "TESTING_to_CANDIDATE":
    case "VALIDATED_to_PAPER":
    case "RETIRED_to_CANDIDATE":
      return { ok: true, reason: "user-initiated transition" };
    case "PAPER_to_ACTIVE":
      return guardPaperToActive(ctx.PAPER_to_ACTIVE);
    case "ACTIVE_to_DECAYING":
      return guardActiveToDecaying(ctx.ACTIVE_to_DECAYING);
    case "DECAYING_to_ACTIVE":
      return { ok: true, reason: "manual recovery confirmation" };
    case "PAPER_to_RETIRED":
    case "ACTIVE_to_RETIRED":
    case "DECAYING_to_RETIRED":
      return { ok: true, reason: "user-initiated retirement" };
    default:
      return { ok: false, reason: `no guard implemented for ${from} -> ${to}` };
  }
}
