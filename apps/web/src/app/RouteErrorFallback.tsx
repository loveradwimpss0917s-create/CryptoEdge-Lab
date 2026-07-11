import type { ErrorComponentProps } from "@tanstack/react-router";

// No screen had a render-error fallback before this (2026-07 audit): one
// uncaught throw (e.g. a screen indexing into a malformed API response)
// blanked the whole SPA with no way back short of a manual reload. This is
// TanStack Router's per-route error boundary, so a crash in one screen
// doesn't take out the nav/layout around it.
export function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  return (
    <div className="space-y-3 rounded border border-reject/40 bg-slate-900 p-4 text-sm">
      <p className="text-reject">このページの表示中にエラーが発生しました。</p>
      <p className="text-xs text-slate-500">{error instanceof Error ? error.message : String(error)}</p>
      <button
        type="button"
        className="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-950"
        onClick={() => reset()}
      >
        再試行
      </button>
    </div>
  );
}
