// Lightweight, O(1)-per-update statistics for use inside Worker request
// handlers (docs/01 §4.1: no CPU-heavy recomputation from raw history at
// request time — that belongs to research-worker). Welford's online
// algorithm lets us maintain a rolling mean/variance from a small persisted
// state blob instead of rescanning history on every tick.

export interface OnlineMoments {
  n: number;
  mean: number;
  m2: number; // sum of squared deviations from the mean
}

export function emptyMoments(): OnlineMoments {
  return { n: 0, mean: 0, m2: 0 };
}

export function updateMoments(state: OnlineMoments, x: number): OnlineMoments {
  const n = state.n + 1;
  const delta = x - state.mean;
  const mean = state.mean + delta / n;
  const delta2 = x - mean;
  const m2 = state.m2 + delta * delta2;
  return { n, mean, m2 };
}

export function variance(state: OnlineMoments): number {
  return state.n > 1 ? state.m2 / (state.n - 1) : 0;
}

export function stddev(state: OnlineMoments): number {
  return Math.sqrt(variance(state));
}

/** z-score of `x` against the moments accumulated so far. Returns 0 if variance is not yet defined. */
export function zScore(state: OnlineMoments, x: number): number {
  const sd = stddev(state);
  return sd > 0 ? (x - state.mean) / sd : 0;
}

/**
 * Exponentially-weighted moving average update — used where a hard rolling
 * window isn't tracked (cheaper than Welford, appropriate for premium/basis
 * smoothing where recency matters more than exact-window semantics).
 */
export function ewmaUpdate(prev: number | null, x: number, alpha: number): number {
  return prev === null ? x : alpha * x + (1 - alpha) * prev;
}
