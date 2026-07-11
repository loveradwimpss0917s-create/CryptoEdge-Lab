// 日本語UI表示用ラベル。EDGE_STATUS の値そのもの(IDEA/CANDIDATE 等)は
// API契約・DBの列挙値なので変更せず、表示テキストのみここで対応付ける。
import type { EdgeStatus } from "@cryptoedge/schema";
import type { MissingElements, Readiness, ReadinessState } from "../api/client";

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

// Research Readiness (docs/06 §7, 2026-07 design). state のラベルと色は
// カード/kanban 列/Today サマリで共通利用。
export const READINESS_STATE_LABEL: Record<ReadinessState, string> = {
  VALIDATED_PLUS: "検証済み以降",
  FULL_DONE: "FULL済み",
  SCREEN_DONE: "SCREEN済み",
  READY: "READY",
  DATA_PENDING: "DATA待ち",
  FEATURE_PENDING: "FEATURE待ち",
  SIGNAL_SPEC_PENDING: "SignalSpec待ち",
  BUILD_PENDING: "実装待ち"
};

export const READINESS_STATE_BADGE_CLASS: Record<ReadinessState, string> = {
  VALIDATED_PLUS: "bg-adopt text-slate-950",
  FULL_DONE: "bg-slate-700 text-slate-100",
  SCREEN_DONE: "bg-slate-700 text-slate-100",
  READY: "bg-emerald-600 text-slate-950",
  DATA_PENDING: "bg-watch text-slate-950",
  FEATURE_PENDING: "bg-watch text-slate-950",
  SIGNAL_SPEC_PENDING: "bg-slate-600 text-slate-100",
  BUILD_PENDING: "bg-slate-800 text-slate-400"
};

// docs/06 §7.2 の「次に実行すべきアクションを1つだけ表示」。missing の中身
// (feature/data/event 名) を埋め込み、具体的な文言にする。
//
// `latestFullVerdict`: FULL_DONE の文言はかつて verdict に関わらず常に
// 「TESTING→VALIDATEDを判断」という固定文言だった。verdict が REJECT/WATCH
// (ADOPT 以外) の場合、TESTING→VALIDATED は `canTransition` のガード
// (docs/05 §2 "full run の verdict = ADOPT") で必ず弾かれる — つまり
// 案内文が実際には選べない遷移を「次のアクション」として示していた
// (2026-07 ユーザー報告: 「月曜アジア開場効果」で実際にこの文言に従って
// もVALIDATEDへ進めず、対応するボタンが無いように見えて混乱した)。
export function nextActionLabel(
  readiness: Readiness,
  latestFullVerdict?: "ADOPT" | "WATCH" | "REJECT" | null
): string {
  const { state, missing } = readiness;
  switch (state) {
    case "VALIDATED_PLUS":
      return "Dossierで証跡を確認";
    case "FULL_DONE":
      if (latestFullVerdict === "ADOPT") return "verdict=採用 → 「→検証済み」ボタンでVALIDATEDへ";
      if (latestFullVerdict === "REJECT" || latestFullVerdict === "WATCH")
        return `verdict=${VERDICT_LABEL[latestFullVerdict]} (ADOPTではないためVALIDATEDには進めません) → 「→却下」ボタンで却下、または再評価を検討`;
      return "verdictをレビュー → TESTING→VALIDATEDを判断";
    case "SCREEN_DONE":
      return "screen結果をレビュー";
    case "READY":
      return "screen評価を実行";
    case "DATA_PENDING": {
      const targets = [...(missing.data ?? []), ...(missing.event ?? [])];
      return `不足データのバックフィルを実行${targets.length > 0 ? ` (${targets.join(", ")})` : ""} → Data Health`;
    }
    case "FEATURE_PENDING": {
      const targets = missing.feature ?? [];
      return `featureをFeature Storeに追加${targets.length > 0 ? ` (${targets.join(", ")})` : ""}`;
    }
    case "SIGNAL_SPEC_PENDING":
      return "signal_specを作成 → 版エディタ";
    case "BUILD_PENDING": {
      const targets = missing.build ?? [];
      return `必要な実装項目に着手${targets.length > 0 ? ` (${targets.join(", ")})` : ""}`;
    }
  }
}

export function missingElementsSummary(missing: MissingElements): string[] {
  const chips: string[] = [];
  if (missing.signalSpec) chips.push("SignalSpec");
  for (const f of missing.feature ?? []) chips.push(`Feature: ${f}`);
  for (const d of missing.data ?? []) chips.push(`Data: ${d}`);
  for (const e of missing.event ?? []) chips.push(`Event: ${e}`);
  for (const b of missing.build ?? []) chips.push(`Build: ${b}`);
  return chips;
}
