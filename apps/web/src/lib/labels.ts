// 日本語UI表示用ラベル。EDGE_STATUS の値そのもの(IDEA/CANDIDATE 等)は
// API契約・DBの列挙値なので変更せず、表示テキストのみここで対応付ける。
import type { EdgeStatus } from "@cryptoedge/schema";

export const STATUS_LABEL: Record<EdgeStatus, string> = {
  IDEA: "アイデア",
  CANDIDATE: "候補",
  TESTING: "検証中",
  VALIDATED: "検証済み",
  PAPER: "ペーパートレード",
  ACTIVE: "運用中",
  DECAYING: "劣化中",
  RETIRED: "引退",
  REJECTED: "却下"
};

// docs/13 §7 の無料枠リソース名。未知の resource は id をそのまま表示する
// (quota_usage.resource は将来 R2/Actions 分数等が追加される想定 — docs/13
// §6, Task4)。
export const QUOTA_RESOURCE_LABEL: Record<string, string> = {
  d1_writes: "D1 書き込み (行/日)",
  d1_reads: "D1 読み込み (行/日)",
  worker_requests: "Worker リクエスト (回/日)",
  kv_writes: "KV 書き込み (回/日)"
};
