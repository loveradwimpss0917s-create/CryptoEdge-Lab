# 16. Edge + SignalEvent 2層構造 — kasotubot 向け外部インターフェース設計 (v2)

> 位置づけ: CryptoEdge Lab (本リポジトリ) は「研究・評価・シグナル検知」まで、執行・複数戦略配分は
> 外部システム (kasotubot、別リポジトリにつき本設計書のみで完結させる) の責務 — docs/00/01 の
> スコープ分離を踏襲する。本書はその境界面 (Edge → SignalEvent → kasotubot) の契約を定義する。
> V2 スコープ (docs/09 §4) — SONNET-5 の paper_signals writer 実装を前提とするが、本書自体は
> それをブロックしない。

## 1. 背景

kasotubot は現在「単一ルール実行アプリ」。CryptoEdge Lab が検証・ADOPT した Edge を随時 kasotubot に
供給し、複数戦略を同時評価してポジションを決める「トレードOS」へ進化させたい。

## 2. 2層モデル

| 層 | 役割 | 本リポジトリでの実体 |
|---|---|---|
| **Edge** | 仮説・signal_spec (DSL) の静的定義。バージョン管理・EEP評価・verdict・lifecycle 状態を持つ | `edges` + `edge_versions` + `verdicts` (既存) |
| **SignalEvent** | Edge の `when` 条件が実際に成立した瞬間の具体的インスタンス | 新規 (本書で定義) — `paper_signals` (既存, PAPER評価用) と発火検知ロジックを共有するが別物 (§4) |

kasotubot が消費するのは Edge の signal_spec (DSL) そのものではなく、CryptoEdge Lab 側で評価済みの
SignalEvent。kasotubot は DSL 評価器を再実装する必要がなく、イベントを受け取って執行判断するだけで済む。

## 3. SignalEvent v2 スキーマ — delta-only 設計

**原則**: SignalEvent はポートフォリオの **state を持たない**。「そのシグナルを採用した場合の
増分 (marginal impact)」のみを運ぶ。kasotubot 側が自身の現在ポートフォリオ state と突き合わせて
差分評価する — CryptoEdge Lab はkasotubotの内部状態を保持・追跡しない (疎結合の核)。

```
SignalEvent {
  signal_id: string            # ULID, 新規発火ごとに採番
  edge_id: string
  edge_version_id: string
  ts_signal: number             # 発火時刻 (unix ms)
  direction: "long" | "short"
  instrument_id: string

  # --- marginal impact (意思決定に必要な最小の影響情報) ---
  marginal_exposure: number      # このシグナルを採用した場合に追加される想定エクスポージャー
  marginal_risk: number          # 追加される想定リスク量 (VaR/想定ボラ寄与など、単位はkasotubot側と合意)
  correlation_to_active_portfolio: number  # 圧縮表現 (-1..1 の単一スカラー, §3.1)
  capacity_usage_delta: number    # 戦略あたり容量枠に対する追加消費割合

  meta: { trigger_snapshot: object }  # DSL評価に使った特徴量スナップショット (再現性用、既存 paper_signals.trigger_snapshot と同形式)
}
```

### 3.1 `correlation_to_active_portfolio` の圧縮表現

`edge_correlations` (既存テーブル: edge_a/edge_b/window/signal_overlap/return_corr) は Edge 対 Edge の
ペア相関。kasotubot に渡す際は「このEdgeと、現在アクティブな全戦略の加重平均相関」1スカラーに圧縮する
(具体的な集約式 — 単純平均か、想定サイズ加重平均か — は §5 のオープン項目)。

## 4. `paper_signals` との関係

発火検知ロジック (DSL評価器が `when` 成立を確認する箇所) は共有するが、下流の書き込み先は
Edge の lifecycle 状態で分岐する:

| Edge 状態 | 発火時の挙動 |
|---|---|
| PAPER | `paper_signals` へ記録 (既存スキーマ、事後に `ret_bps`/`ret_net_bps` を確定させ PAPER→ACTIVE ゲート評価に使う、docs/05) |
| ACTIVE | `paper_signals` への記録に加えて (実績追跡を止めない)、SignalEvent v2 を kasotubot へ送出 |

SONNET-5 (docs/15) はこの共有インフラ (発火検知 + `paper_signals` writer) をまず実装する。
ACTIVE 時の SignalEvent 送出は、本書の §5 が未解決な間はスコープ外 (V2 の中でも後続フェーズ)。

## 5. オープン項目 (kasotubot 側で解決が必要、本書では未解決のまま明示)

1. **ポートフォリオ state の受け渡し方式**: `marginal_exposure`/`correlation_to_active_portfolio` 等の
   delta を計算するには、計算時点での kasotubot の現在ポートフォリオ state (何をどれだけ保有中か) を
   CryptoEdge Lab 側が知る必要がある。SignalEvent 自体は state を持たないが、**delta を計算する入力**
   としての state は必要 — 3方式が考えられる:
   - (a) kasotubot が最新 state を CryptoEdge Lab へ push (webhook/API)
   - (b) CryptoEdge Lab が発火の都度 kasotubot へ pull (同期呼び出し、レイテンシ要件次第で不可な場合あり)
   - (c) kasotubot が定期的にスナップショットを共有ストレージ (R2等) へ書き、CryptoEdge Lab が直近版を読む
   どれを選ぶかは kasotubot 側のアーキテクチャ (同期/非同期、レイテンシ要件) 次第。
2. **`correlation_to_active_portfolio` の集約式**: 単純平均・サイズ加重平均・最大値のいずれか (§3.1)
3. **配信経路**: SignalEvent を kasotubot へどう渡すか (Webhook POST / キュー / ポーリングAPI) — 本
   リポジトリの Free-tier 制約 (docs/13) との整合を要確認 (Cloudflare Workers Free は Queues 無し)
4. **`marginal_risk`/`capacity_usage_delta` の単位系**: kasotubot 側のリスク管理単位に合わせる必要が
   あり、CryptoEdge Lab 単独では確定できない

本書は上記オープン項目の解決を前提とせず、次に kasotubot 側と合意すべき論点を明示することを目的とする。
