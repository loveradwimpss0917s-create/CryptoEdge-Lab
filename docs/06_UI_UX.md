# 06. UI/UX 設計

> 設計原則 (docs/00 §3-8): 情報の陳列ではなく、**毎画面が「次に何をすべきか」を答える**。
> 研究者の 1 日: 朝 5 分 (Today) → 気になれば深掘り (Dossier / Discovery Lab) → 承認/却下の意思決定。

---

## 1. UX の中核コンセプト

1. **Action Queue**: システムが人間に求める意思決定 (遷移承認、findings レビュー、DQ 対応) を単一のキューとして常時ヘッダに表示。ゼロインボックス型
2. **Verdict は理由と共に**: すべての数値バッジはクリックで「なぜ」(reasons JSON の可視化) に展開。閾値との差分を必ず併記
3. **統計的誠実さの UI 化**: 多重検定未補正値・コスト前値はグレー表示 + 「参考値」ラベル。試行回数カウンタを Edge カードに常時表示 (「この Edge は 14 回試された」)
4. **状態機械がナビゲーション**: Edge Board は kanban (状態 = 列)。研究の進捗が空間的に見える
5. **[Copy for AI] の遍在** (docs/07): Dossier / finding / DQ issue / Briefing のすべてに Research Pack コピーを置き、外部 AI への持込みを 1 クリック化。貼り戻し欄で AI 回答も研究記録になる
6. **深掘りはブラウザ内で完結**: Discovery Lab の Explorer タブは DuckDB-WASM が R2 Parquet を直接読み、任意条件の分布・層別をサーバ計算なしで返す (無料枠を消費しない探索、docs/01 §3.3)
7. **Research Readiness (研究準備状況)**: 各 Edge が「今すぐ評価できる状態か、できないなら何がブロックしているか」を自動判定し、状態と**次の一手 1 つ**を常時提示する (詳細 §7)。lifecycle 状態 (IDEA→…→ACTIVE) が「研究の到達点」を表すのに対し、readiness は「今日この Edge を前進させるために必要な作業の種類」を表す直交軸。**「今日は何を開発・評価すればよいか」を UI を見ただけで判断できる**ことがこのツールの中核目的

## 2. 画面一覧と遷移

| ID | 画面 | 役割 | 主データ |
|---|---|---|---|
| SCR-01 | **Today** (ホーム) | 朝の 5 分。ブリーフィング + Action Queue + **Readiness サマリ** + 市況/レジーム | ai_outputs(briefing), jobs, regimes, paper_signals, **edges(readiness)** |
| SCR-02 | **Edge Board** | 全 Edge のライフサイクル俯瞰 (kanban) + **Readiness ビュー** + Portfolio タブ | edges, edge_versions, eval_runs, feature_defs, events, verdicts, edge_correlations |
| SCR-03 | **Edge Dossier** | 1 Edge の全証拠。仮説→バージョン→Run→判定→ペーパー実績 | edges, edge_versions, eval_*, paper_signals |
| SCR-04 | **Discovery Lab** | findings レビュー、候補生成の設定、文献インポート、**Explorer (DuckDB-WASM によるブラウザ内アドホック分析)** | discovery_findings, feature_defs, R2 Parquet (直接読み) |
| SCR-05 | **Data Health** | 収集状態・品質スコア・DQ issues・ソース管理 | ingest_state, dq_issues, data_sources |
| SCR-06 | **Reports** | 日次ブリーフィング/週次レポートのアーカイブ | ai_outputs, R2 reports |
| SCR-07 | **Settings** | 閾値セット、コストモデル、AI 予算、API キー状態 | settings |

```
遷移図:
Today ──(action)──▶ Dossier / Discovery Lab / Data Health
Edge Board ──(カード)──▶ Dossier ──(バージョン比較/新バージョン作成)──▶ Dossier
Discovery Lab ──(昇格)──▶ Dossier (新規 CANDIDATE)
全画面 ⇄ グローバルナビ (左レール: 01–07) + Cmd-K パレット (Edge 検索/ジャンプ)
```

## 3. ワイヤーフレーム

### SCR-01 Today

```
┌────────────────────────────────────────────────────────────────────┐
│ ◤ CryptoEdge Lab   [Today] Board Discovery Data Reports ⚙   🔔3    │
├──────────────────────────────┬─────────────────────────────────────┤
│ ☀ Briefing 2026-07-02        │ ▶ ACTION QUEUE (3)                  │
│ TL;DR                        │ ① 承認: cme-gap-fill v1.2           │
│ ・BTC $XX,XXX (+1.2%)        │    TESTING→VALIDATED (ADOPT, 92点)  │
│   regime: up/low/normal      │    [Dossier を見る] [承認] [却下]    │
│ ・usdt-mint-drift が発火,     │ ② レビュー: 新 findings 5件         │
│   +34bps (paper)             │    最良: oi_accel×liq_z (q=0.03)    │
│ ・⚠ funding-reversion decay  │ ③ DQ: farside 欠損 2日 (warn)       │
│   警報 (CUSUM)               │─────────────────────────────────────│
│ [全文を読む] [Copy for AI]   │ 📊 Portfolio Pulse                  │
│──────────────────────────────│  ACTIVE 4 / PAPER 3 / 有効独立数 2.6│
│ 今日やるべきこと              │  昨日: シグナル3件 net +21bps       │
│ 1. decay 原因を確認 →[Dossier]│  30d paper equity ▁▂▃▅▄▆▇          │
│ 2. findings ①を評価 →[Lab]   │─────────────────────────────────────│
│ 3. farside 復旧確認 →[Data]  │ 🧭 RESEARCH READINESS               │
│                              │  今すぐ評価可能: 3件 [まとめて screen]│
│                              │  ┌ ブロック内訳 (クリックで Board 絞込)┐│
│                              │  │ 実装待ち     40  (新データ源 C/D) ││
│                              │  │ SignalSpec待 5   (A/B, 仕様未作成)││
│                              │  │ FEATURE待ち  1                    ││
│                              │  │ DATA待ち     2   (OI/LS 履歴欠損) ││
│                              │  └────────────────────────────────────┘│
│                              │  レビュー待ち: SCREEN 5 / FULL 0     │
│                              │─────────────────────────────────────│
│                              │ 市況ストリップ: RV30 42%(p61)       │
│                              │ funding +0.8bps DVOL 51 F&G 63     │
└──────────────────────────────┴─────────────────────────────────────┘
```
Readiness サマリは「今すぐ評価可能な Edge 数」+「ブロック理由の内訳」+「人間のレビュー待ち件数 (SCREEN/FULL 済み)」を提示する。各行はクリックで Edge Board の Readiness ビューを該当状態で絞り込む。数値は §7 の readiness 自動判定を集計したもの (上例は 2026-07 Edge Pack v1 実行後の実測値: READY 3 は OI/LS 非依存の time/price 系, DATA待ち 2 は OI・Top-Trader L/S 依存 Edge)。

**実装状況 (docs/15 SONNET-2/7, 2026-07)**: Briefing パネル (daily_briefing Pack の本文表示 + [Copy for AI]、
折りたたみ可能) と Action Queue (SCREEN_DONE/FULL_DONE Edge のレビュー・承認待ち + open DQ critical
issue) を実装済み。Portfolio Pulse (ACTIVE/PAPER件数・有効独立数・paper equity曲線) は未実装のまま
(paper_signalsの母数が少ないうちは意味のある表示にならないため、docs/09 P2の相関/ポートフォリオ機能と
合わせて実装する想定)。Action Queue の findings 由来の項目は Discovery Engine 未実装のため対象外 (V2)。
日付選択 (過去のBriefing閲覧) は未実装、常に最新版のみ表示。

### SCR-02 Edge Board (kanban)

```
┌ フィルタ: category▾ readiness▾ 検索🔍  タブ: [Lifecycle] [Readiness] [Portfolio]┐
│ IDEA(41) CANDIDATE(6) TESTING(3) VALIDATED(2) PAPER(3) ACTIVE(4) ⚰(9)│
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │eth-spill│ │liq-rebnd│ │fomc-drft│ │cme-gap │ │usdt-mint│ │21utc-drf│  │
│ │🔨実装待 │ │🟢READY  │ │run 中⏳ │ │92 ADOPT│ │+34bps/d │ │▂▃▅ CUSUM│  │
│ │trials:0 │ │trials:3 │ │        │ │trials:14│ │sig 12   │ │ ok      │   │
│ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘   │
│ カード: title / readiness チップ / score / verdict / 試行数 / スパーク │
└──────────────────────────────────────────────────────────────────────┘
[Readiness タブ] 列 = readiness 状態。各 Edge を「今日必要な作業の種類」で分類:
┌実装待ち(40)┐┌SignalSpec待(5)┐┌FEATURE待(1)┐┌DATA待(2)┐┌🟢READY(3)┐┌SCREEN済(5)┐┌FULL済(0)┐
│ 各列ヘッダに「その列の Edge に共通の次アクション」+件数。列内カードは │
│ 不足要素チップ (Feature/Data/Event/SignalSpec/Build) と [次アクション] ボタン │
└──────────────────────────────────────────────────────────────────────┘
[Portfolio タブ] 相関ヒートマップ + クラスタ樹形図 + 有効独立数 KPI +
「追加候補の限界 Sharpe」表
```
- **Lifecycle ビュー**: 従来通り lifecycle 状態が列。各カードに readiness チップを重畳表示 (状態が「進んでいる」kanban 上でも、今その Edge に必要な作業が一目で分かる)
- **Readiness ビュー**: readiness 状態が列。「今日どの種類の作業から着手するか」を空間的に選べる。列ヘッダの共通アクション (例: DATA待ち列 →「バックフィル実行」) で列単位のバッチ操作も可能
- `readiness▾` フィルタと `readiness` ソートは両ビュー共通。category × readiness の二軸絞り込み可

### SCR-03 Edge Dossier (タブ構成)

```
┌ usdt-mint-drift  [PAPER]  score 88  trials 9  origin: pdf_seed EC-031 ┐
│ タブ: [Thesis] [Evidence] [Runs] [Paper] [Versions] [Related]         │
│ Thesis: hypothesis / rationale (4源泉タグ: forced_flow) /             │
│         counter_evidence (Wei 2018 反証, ≤60min 限定) / evidence 文献 │
│ Evidence: 最新 full run の全メトリクス表 (CI 付き)                     │
│   ┌ Verdict: ADOPT ── なぜ? ▾ ────────────────────────┐              │
│   │ ✓ EV CI下限 +8bps > 0   ✓ DSR 0.93 ≥ 0.90         │              │
│   │ ✓ p_perm 0.012          ✗ regime:down_high で EV− │→ WATCH条件   │
│   └────────────────────────────────────────────────────┘              │
│   equity curve (OOS 区間着色) / レジーム別バー / fold 別表 /           │
│   トレード分布ヒストグラム / top5 集中度                                │
│ Paper: シグナル一覧 (trigger_snapshot 展開可) / paper vs OOS 乖離帯    │
│ Versions: v1.0→v1.2 の diff (params/signal_spec) + changelog          │
│ Related: 相関の高い Edge / 同一 finding 由来 / novelty 重複            │
│ [新バージョンを作る] [full 評価を実行] [状態遷移▾]                     │
└──────────────────────────────────────────────────────────────────────┘
```

### SCR-04 Discovery Lab

```
┌ [Findings Inbox] [Explorer] [Screen Config] [Import from Literature] ┐
│ Findings (今週 12 / FDR q<0.10):  ソート: score▾                      │
│ ┌ oi_accel_24h>2σ ∧ liq_z>2 → fwd72h  ────────────────┐             │
│ │ n=87 (n_eff 61)  EV +41bps  q=0.031  novelty 0.82    │             │
│ │ 分布図 / 年別安定性 / regime 別   [却下] [Edge に昇格]│             │
│ │ [Copy for AI] finding_review Pack → Claude 等で接地判定│             │
│ │ [Paste AI response] → rationale ドラフト取込 (zod 検証)│             │
│ └───────────────────────────────────────────────────────┘             │
│ Explorer タブ: DuckDB-WASM。データセット選択 → 条件式・層別・horizon  │
│   を指定して分布/散布/層別表を即時描画 (サーバ計算なし)。              │
│   「この条件を Screen 候補として保存」→ 次回 weekly バッチに追加       │
│ Screen Config: 試行空間サイズ表示「現在 2,412 試行/バッチ。            │
│   θグリッド追加は FDR 検出力を下げます」← 統計的誠実さの UI            │
└──────────────────────────────────────────────────────────────────────┘
```

### SCR-05 Data Health

```
ソース×ストリーム格子 (品質スコア色分け) / watermark 遅延表 /
open issues リスト (AI 分類ラベル付き) / 改訂頻度 (revisable 系列) /
[手動リフィル実行] [ソース無効化]
```

**実装状況 (docs/15 SONNET-4, 2026-07)**: ソース×ストリーム格子 (品質スコア色分け) と open issues
リストは実装済み (`GET /api/v1/data-health` + `/data-health` 画面)。watermark 遅延表・改訂頻度・
AI 分類ラベル・[手動リフィル実行]・[ソース無効化] は未実装 (後者2つは新規ミューテーション
エンドポイントが必要)。品質スコアは docs/03 §6 の30日ローリング値ではなく、`ingest_state` の
現在状態 (連続エラー数・最終実行時刻) から都度計算する近似値 (docs/08 Data Health節に詳細)。

SCR-06/07 は標準的なリスト+フォームで足りる (詳細省略、実装は shadcn/ui パターン)。

## 4. 主要ユーザーフロー

1. **朝のループ (5 分)**: Today → Action Queue を上から処理 → 空になったら終了
2. **発見→昇格**: Lab で finding 確認 → 分布・安定性チェック → hypothesis/rationale 記入 (AI ドラフト活用) → CANDIDATE 作成 → screen run 自動起動
3. **評価→採用**: TESTING の full run 完了通知 → Dossier で reasons 確認 → 承認 → PAPER 30 日 → ACTIVE
4. **劣化対応**: decay 警報 → Dossier の Paper タブで乖離確認 → AI の原因仮説 → 新バージョン (条件付け追加) or RETIRED

## 5. 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| フレームワーク | React 18 + TypeScript + Vite | SPA で十分 (SSR 不要: 認証必須の単一ユーザ研究ツール) |
| ルーティング | TanStack Router | 型安全 |
| データ取得 | TanStack Query + openapi-fetch | packages/schema から型生成、SWR キャッシュ |
| UI 基盤 | Tailwind + shadcn/ui | 実装速度と一貫性 |
| チャート | Lightweight Charts (価格系) + ECharts (統計図: 分布/ヒートマップ/樹形図) | 金融チャートは LWC が最軽量。統計可視化の表現力は ECharts |
| ブラウザ内分析 | **DuckDB-WASM** (R2 Parquet を HTTP Range 読み) | サーバ計算ゼロで数十万行のアドホック集計。無料枠を消費しない探索層 (docs/01 §3.3)。SQL 部品はサーバ版 DuckDB と互換で将来サーバ移行可能 |
| テーブル | TanStack Table | 仮想化 |
| 状態 | サーバ状態は Query、UI 状態は Zustand 最小限 | |

## 6. デザインシステム要点

- ダークテーマ既定 (研究端末想定)、ライト対応はトークン設計のみ先行
- カラー・セマンティクス: ADOPT=green / WATCH=amber / REJECT=red / DECAYING=orange / 参考値=グレー40%。**色だけに依存しない** (バッジに必ず文字)
- 数値表示規約: bps は符号付き整数、確率は小数 2 桁、CI は `+8 [+2, +15]` 形式。時刻表示は UTC 固定 (ローカル表示は tooltip)
- 密度: 研究者向けに高密度テーブルを許容 (行高 32px)。モバイルは Today + 通知閲覧のみ最適化 (閲覧専用)
- 空状態: 各画面に「次の一歩」を書く (例: Board が空 → 「PDF シード 54 件をインポート」ボタン)

## 7. Research Readiness (研究準備状況)

> 目的: 「今日は何を開発・評価すればよいか」を UI を見ただけで判断できる研究管理ダッシュボードにする。各 Edge の readiness を自動判定し、**次の一手 1 つ**を提示する。

### 7.1 lifecycle と readiness の関係 (直交する 2 軸)

- **lifecycle** (`edges.status`, docs/05 §2): IDEA→CANDIDATE→TESTING→VALIDATED→PAPER→ACTIVE。研究の**到達点**。
- **readiness**: その Edge を今前進させるために必要な**作業の種類**。lifecycle とは別に計算され、同じ IDEA でも「signal_spec を書けば評価できる」のか「新データ源の実装が要る」のかを区別する。docs/14 (Edge Pack v1) の A/B/C/D 分類を、静的な計画表ではなく**ライブに自動判定される状態**へ昇華したもの。

### 7.2 readiness 状態の定義 (8 状態)

各 Edge の**現在の edge_version (is_current=1)** を対象に、上から順に評価し最初に合致した状態を採る:

| readiness | 判定条件 | 不足要素 | 次アクション (1 つだけ表示) |
|---|---|---|---|
| `VALIDATED+` | lifecycle ∈ {VALIDATED, PAPER, ACTIVE, DECAYING} | — | Dossier で証跡を確認 (評価フェーズ完了) |
| `FULL_DONE` (FULL済み) | 現行版に full run (status=done) が存在 | — | verdict をレビュー → TESTING→VALIDATED を判断 |
| `SCREEN_DONE` (SCREEN済み) | 現行版に screen run (done) が存在、full 未実施 | — | screen 結果をレビュー (合格→CANDIDATE→TESTING / REJECT→却下 or 再設計) |
| `READY` | 現行版に signal_spec あり ∧ 参照する feature/event/regime が**全て利用可能** | — | **screen 評価を実行** ([/eval] トリガ) |
| `DATA_PENDING` (DATA待ち) | signal_spec あり ∧ 参照 feature は feature_defs に**定義済みだが元データ不足** (or 参照 event 種別/regime にデータなし) | Data[], Event[] | 不足データのバックフィルを実行 → Data Health |
| `FEATURE_PENDING` (FEATURE待ち) | signal_spec あり ∧ 参照 feature が feature_defs に**未定義** | Feature[] | feature を Feature Store に追加 (registry.py) |
| `SIGNAL_SPEC_PENDING` (SignalSpec待ち) | 現行版の signal_spec が未作成 ∧ 計画上の依存が**現構成で充足可能** (docs/14 分類 A/B) | SignalSpec | signal_spec を作成 → Dossier の版エディタ |
| `BUILD_PENDING` (実装待ち) | signal_spec 未作成 ∧ 計画上**未実装のデータ源/DSL ノード**が必要 (docs/14 分類 C/D) | Build[] (例: "Coinbase価格", "L2板", "day-of-month DSL") | 必要な実装項目に着手 (ロードマップ §) |

REJECT で終わった screen/full も、新バージョンを作れば readiness は再び READY 系へ戻る (readiness は常に現行版基準)。SCREEN_DONE / FULL_DONE は**人間のレビュー待ち**を意味し、Action Queue (§1-1) の項目源にもなる。

### 7.3 READY 判定は評価器の fail-closed チェックと同一ロジック

READY / DATA_PENDING / FEATURE_PENDING の切り分けは、`research/.../jobs/on_demand.py` が評価前に行う fail-closed 検査 (`_referenced_features` / `_referenced_event_types` / `_uses_regime`, 2026-07 TASK-1/Task5) と**同じ依存抽出**を使う。これにより「UI で READY = on_demand.py で fail-closed しない」が保証される (両者がずれると「READY なのに評価が失敗」が起きるため、依存抽出は必ず単一実装を共有する)。

- **実装ノート (Sonnet 引き継ぎ)**: 依存抽出 (`referencedFeatures(signalSpec)` / `referencedEventTypes` / `usesRegime`) を `packages/schema` に TS で置き、api Worker (readiness 計算) と ingest 側 DSL 評価器が共用。Python 側 (`on_demand.py`) は docs/11 §4 の golden vector で TS と一致を担保。
- **FEATURE待ち vs DATA待ちの区別** (Phase 1 で実証された核心): `feature_defs` に行があるか (定義の有無) と、その feature の base データ源が実際に十分な行数/期間を持つか (データの有無) は別物。例: `v1.ls_top_trader_z_30d` は registry に定義済み (FEATURE は満たす) だが `long_short_ratios` が 0 行のため **DATA待ち**。データ充足判定は feature の base 表 (funding_rates/open_interest/long_short_ratios 等) の行数・watermark を `lookback_required` と突き合わせて行う。

### 7.4 不足要素の型 (missing elements)

readiness と併せて、UI は不足要素を型付きリストで表示する: `{ signalSpec?: bool, feature?: string[], data?: string[], event?: string[], build?: string[] }`。カードのチップと Dossier ヘッダに表示し、「あと何が揃えば評価できるか」を明示する。

### 7.5 自動判定の実行場所と API

- readiness は api Worker が算出し、`GET /api/v1/edges` の各行に計算フィールド `readiness` (状態 + 不足要素 + 次アクション) として付与する (専用集計は `GET /api/v1/edges/readiness-summary` が Today 用の件数内訳を返す)。
- 計算入力: `edges` (status, docs/14 分類注記), `edge_versions` (signal_spec), `eval_runs` (screen/full 実績), `feature_defs` (定義済み feature), 各 base データ表の行数/watermark, `events` (種別ごと有無)。
- `BUILD_PENDING` の「計画上の依存」だけは自由文の hypothesis から自動導出できないため、docs/14 の A/B/C/D 分類を `edges.readiness_class` (A/B=spec 可 / C/D=要実装) + `edges.readiness_blockers` (不足実装項目のテキスト列) として保持し、判定に用いる。ここが唯一の非自動 (人間 or AI 注釈) 要素であることを UI でも明示する。

### 7.6 実測例 (2026-07 Edge Pack v1 Phase 1)

| Edge | readiness | 不足要素 | 次アクション |
|---|---|---|---|
| funding-rate-mean-reversion (screen=REJECT) | SCREEN_DONE | — | 結果レビュー → 却下 or z 閾値再設計で新版 |
| monday-asia-open (screen=REJECT) | SCREEN_DONE | — | 同上 |
| open-interest-price-divergence | DATA待ち | data: `open_interest 履歴` | binance.vision `metrics` 調達待ち → Data Health |
| top-trader-ls-extremes | DATA待ち | data: `long_short_ratios` | 同上 |
| stablecoin-issuance-acceleration | 実装待ち | build: `stablecoin 供給データ源` | データ源実装に着手 |
| 25-delta-risk-reversal | 実装待ち | build: `options_surface.rr25 収集` | Deribit 板サマリ集計を実装 |

この表は Today の Readiness サマリ (§3 SCR-01) と Edge Board の Readiness ビュー (§3 SCR-02) が同一データから描画する。
