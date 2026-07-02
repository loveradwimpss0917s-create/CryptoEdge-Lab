// All timestamps in this project are epoch milliseconds (UTC). Never use
// Date's local-timezone accessors (getHours/getDay/...) — always the UTC
// variants — since a Worker's runtime timezone is not guaranteed (docs/02
// header conventions).

export type EpochMs = number;
export type DateKey = string; // 'YYYY-MM-DD' (UTC)

export function nowMs(): EpochMs {
  return Date.now();
}

export function toDateKey(ms: EpochMs): DateKey {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

export function dateKeyToMs(key: DateKey): EpochMs {
  return Date.parse(`${key}T00:00:00.000Z`);
}

export function utcHour(ms: EpochMs): number {
  return new Date(ms).getUTCHours();
}

export function utcDayOfWeek(ms: EpochMs): number {
  return new Date(ms).getUTCDay();
}

export function floorToInterval(ms: EpochMs, intervalMs: number): EpochMs {
  return Math.floor(ms / intervalMs) * intervalMs;
}

export const MS = {
  MINUTE: 60_000,
  FIVE_MINUTES: 5 * 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000
} as const;

export function addDays(ms: EpochMs, days: number): EpochMs {
  return ms + days * MS.DAY;
}
