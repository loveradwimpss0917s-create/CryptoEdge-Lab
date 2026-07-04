// Minimal typed fetch wrapper for /api/v1/* (docs/08). Cloudflare Access
// (docs/01 §5) sits in front in production and attaches its own cookie/
// header automatically once the user is authenticated through it — this
// client doesn't need to know about that, only `credentials: "include"`
// so the browser sends whatever Access has set.

const BASE = "/api/v1";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers }
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({
      type: "about:blank",
      title: res.statusText,
      status: res.status
    }))) as ProblemDetails;
    throw new ApiError(problem);
  }
  return res.json() as Promise<T>;
}

// Research Readiness (docs/06 §7, 2026-07 design): an axis orthogonal to
// lifecycle status. Computed server-side (apps/api/src/services/
// readiness.ts) from the current edge_version + eval_runs + feature_defs +
// base-data presence, never stored, so it's always live.
export type ReadinessState =
  | "VALIDATED_PLUS"
  | "FULL_DONE"
  | "SCREEN_DONE"
  | "READY"
  | "DATA_PENDING"
  | "FEATURE_PENDING"
  | "SIGNAL_SPEC_PENDING"
  | "BUILD_PENDING";

export interface MissingElements {
  signalSpec?: boolean;
  feature?: string[];
  data?: string[];
  event?: string[];
  build?: string[];
}

export interface Readiness {
  state: ReadinessState;
  missing: MissingElements;
}

export interface EdgeSummary {
  edge_id: string;
  slug: string;
  title: string;
  category: string;
  status: string;
  origin: string;
  pdf_ref: string | null;
  created_at: number;
  updated_at: number;
  readiness_class: "A" | "B" | "C" | "D" | null;
  readiness_blockers: string | null;
  readiness: Readiness | null;
}

export interface ReadinessSummary {
  ready_count: number;
  review_pending: { screen: number; full: number };
  blocked_breakdown: {
    build_pending: number;
    signal_spec_pending: number;
    feature_pending: number;
    data_pending: number;
  };
}

export interface VerdictReason {
  check: string;
  passed: boolean;
  value: number | null;
  threshold: number | null;
}

export interface RunSummary {
  run_id: string;
  run_kind: string;
  status: string;
  started_at: number | null;
  finished_at: number | null;
  verdict: { verdict: "ADOPT" | "WATCH" | "REJECT"; reasons: VerdictReason[]; decided_at: number } | null;
  metrics: { ev_bps: number | null; sharpe: number | null; dsr: number | null; p_perm: number | null };
}

export interface EdgeDetail {
  edge: EdgeSummary & {
    hypothesis: string;
    rationale: string;
    counter_evidence: string | null;
    evidence: string | null;
  };
  current_version: Record<string, unknown> | null;
  latest_verdict: Record<string, unknown> | null;
  runs: RunSummary[];
}

export interface MarketSnapshot {
  snapshot: Record<string, { v: number; ts: number; updated_at: number } | undefined>;
}

export interface QuotaRow {
  resource: string;
  value: number;
  budget: number;
  usage_ratio: number | null;
}

export interface QuotaOverview {
  dt: string;
  quota: QuotaRow[];
}

export const api = {
  listEdges: (params?: { status?: string; category?: string; q?: string }) => {
    const qs = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as string[][]);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ edges: EdgeSummary[] }>(`/edges${suffix}`);
  },
  getEdge: (edgeId: string) => request<EdgeDetail>(`/edges/${edgeId}`),
  transitionEdge: (edgeId: string, to_status: string, reason: string) =>
    request<{ edge_id: string; from_status: string; to_status: string; reason: string }>(
      `/edges/${edgeId}/transitions`,
      { method: "POST", body: JSON.stringify({ to_status, reason }) }
    ),
  evalEdge: (edgeId: string, version_id: string, kind: "screen" | "full") =>
    request<{ job_id: string; status: string }>(`/edges/${edgeId}/eval`, {
      method: "POST",
      body: JSON.stringify({ version_id, kind })
    }),
  marketOverview: () => request<MarketSnapshot>("/market/overview"),
  quotaOverview: () => request<QuotaOverview>("/ops/quota"),
  readinessSummary: () => request<ReadinessSummary>("/edges/readiness-summary")
};
