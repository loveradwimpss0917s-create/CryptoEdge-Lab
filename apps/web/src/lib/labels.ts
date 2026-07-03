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
