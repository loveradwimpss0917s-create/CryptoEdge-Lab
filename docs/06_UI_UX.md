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

## 2. 画面一覧と遷移

| ID | 画面 | 役割 | 主データ |
|---|---|---|---|
| SCR-01 | **Today** (ホーム) | 朝の 5 分。ブリーフィング + Action Queue + 市況/レジーム | ai_outputs(briefing), jobs, regimes, paper_signals |
| SCR-02 | **Edge Board** | 全 Edge のライフサイクル俯瞰 (kanban) + Portfolio タブ | edges, verdicts, edge_correlations |
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
│ 3. farside 復旧確認 →[Data]  │ 市況ストリップ: RV30 42%(p61)       │
│                              │ funding +0.8bps DVOL 51 F&G 63     │
└──────────────────────────────┴─────────────────────────────────────┘
```

### SCR-02 Edge Board (kanban)

```
┌ フィルタ: category▾ 検索🔍        タブ: [Lifecycle] [Portfolio]      ┐
│ IDEA(41) CANDIDATE(6) TESTING(3) VALIDATED(2) PAPER(3) ACTIVE(4) ⚰(9)│
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │eth-spill│ │liq-rebnd│ │fomc-drft│ │cme-gap │ │usdt-mint│ │21utc-drf│  │
│ │…       │ │score 71 │ │run 中⏳ │ │92 ADOPT│ │+34bps/d │ │▂▃▅ CUSUM│  │
│ │        │ │trials:3 │ │        │ │trials:14│ │sig 12   │ │ ok      │   │
│ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘   │
│ カード: title / score / verdict / 試行数 / 直近スパーク / ⚠バッジ     │
└──────────────────────────────────────────────────────────────────────┘
[Portfolio タブ] 相関ヒートマップ + クラスタ樹形図 + 有効独立数 KPI +
「追加候補の限界 Sharpe」表
```

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
