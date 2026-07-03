// Triggers research-worker via repository_dispatch (docs/01 §3.2). Shared
// by both Workers: ingest dispatches research-daily/research-weekly after
// its own tick, and api dispatches research-on-demand from
// POST /edges/{id}/eval (2026-07: wired the eval-trigger path — this used
// to be ingest-only). Worker dispatch is the *primary* trigger; GitHub's
// own `schedule:` in the workflow YAML is a backup only, since scheduled
// triggers on GitHub can be delayed or skipped under load (docs/13 §3).

export interface DispatchConfig {
  githubPat: string;
  repo: string; // "owner/repo"
}

export async function dispatchResearchEvent(
  config: DispatchConfig,
  eventType: "research-daily" | "research-weekly" | "research-on-demand",
  payload?: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${config.repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.githubPat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cryptoedge-worker"
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload ?? {} })
  });
  if (!res.ok) {
    throw new Error(`repository_dispatch(${eventType}) failed: HTTP ${res.status}`);
  }
}
