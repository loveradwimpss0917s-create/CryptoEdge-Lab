// docs/06 §6 number display conventions: funding as a signed percentage,
// everything else as a locale-formatted number.
export function formatSnapshotValue(key: string, v: number): string {
  if (key.startsWith("funding")) return `${(v * 100).toFixed(4)}%`;
  if (key.startsWith("candle") || key.startsWith("oi")) return v.toLocaleString();
  return String(v);
}

export function formatUtcTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
