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

export const VERDICT_LABEL: Record<"ADOPT" | "WATCH" | "REJECT", string> = {
  ADOPT: "採用",
  WATCH: "様子見",
  REJECT: "却下"
};

// verdict.py の VerdictReason.check 名 (docs/05 §5) と1対1対応。未知の
// check は id をそのまま表示する (プロトコル改訂で項目が増減し得るため)。
export const VERDICT_CHECK_LABEL: Record<string, string> = {
  "reject.ci_upper_below_zero": "EV信頼区間の上限が0超え (却下回避)",
  "reject.p_perm_too_high": "p_perm が却下閾値未満 (却下回避)",
  "reject.dsr_too_low": "DSR が却下閾値超え (却下回避)",
  "reject.recent_2y_ev_negative": "直近2年のEVが非負 (却下回避)",
  "adopt.ci_lower_above_zero": "EV信頼区間の下限 > 0",
  "adopt.sharpe": "Sharpe が最低基準以上",
  "adopt.dsr": "DSR (試行数調整後) が採用基準以上",
  "adopt.p_perm": "p_perm が採用基準未満",
  "adopt.n_eff": "実効サンプル数 n_eff が最低基準以上",
  "adopt.fold_consistency": "fold間のEV符号一貫性",
  "adopt.regime_worst_ev": "最悪レジームでのEVが許容範囲内",
  "adopt.top5_concentration": "上位5トレードへの利益集中度が許容範囲内",
  "adopt.corr_max_active": "運用中Edgeとの相関が許容範囲内"
};
