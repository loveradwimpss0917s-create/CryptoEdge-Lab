# 21. Research OS 構想 — 設計レビューと次期ロードマップ (2026-07-12)

> **位置づけ**: 「エッジ管理ツール」から「毎日AIと一緒にエッジを発見する研究OS」への
> 転換設計書。リポジトリ全コード + 本番D1実測に基づく Chief Architect レビュー
> (2026-07-12, Fable セッション) の正典化。実装タスクカードは docs/19 の
> Phase RS 節 (S-100〜S-109)。docs/18 §5 の長期構想を具体化・置換する。

## 0. 診断の要約 (なぜこの転換が必要か)

本番の実測ファネル (2026-07-12):

```
Edge登録 57件
  └─ IDEA 50件 (SignalSpec待ち11 + 実装待ち36 + その他)
  └─ CANDIDATE 6件 / TESTING 1件
       └─ signal_spec作成済み: 7件のみ (登録の12%)
            └─ eval_runs ~20回 → verdict 全REJECT → ADOPT 0
```

9日間でspec化できたのは7件 (≈0.8件/日)。**評価パイプライン (EEP) は1 run数分で
回るのに、その入力 (SignalSpec) を作る人間側が1日1件しか供給できない。律速段階は
評価ではなく「仮説→spec→必要feature特定」の翻訳作業にある。**

「全REJECT」自体は失敗ではない。BTC一銘柄・16 feature・厳格なDSRという条件では、
正しく動く検定装置は大半を棄却するのが正常。このプラットフォームの差別化は
「ADOPTを出すこと」ではなく「**誠実な棄却を高速・低コストで量産し、その屍から
次の仮説を系統的に生成すること**」にある。本書の全Phaseは
「1回の誠実な試行あたりのコスト最小化」と「REJECT後のループ開通」の2点に向ける。

## 1. 現在のコードレビュー (実コード根拠)

### 1.1 実装済みで質が高いもの (壊さないこと)

- **統計的誠実さのコア (research/)**: `eval/pipeline.py` の anchored walk-forward
  (embargo付き) + permutation (screen 200 / full 1000) + block bootstrap CI +
  DSR (n_trials連動) + セグメント別。`eval/verdict.py` の閾値は docs/05 §5 と一致し、
  機械判定がUI/AIから独立している
- **DSL (packages/schema/src/domain/dsl.ts)**: 意図的に非チューリング完全な7ノード文法。
  TS/Python二重実装を golden vector で同期し、依存抽出 (`referencedFeatures` 等) を
  UI (Readiness) と評価器 (fail-closed) が単一実装で共有
- **n_trials 台帳** (`/internal/edges/:id/trial-count`) が DSR の分母に自動接続
- **無料枠アーキテクチャ**: 2 Workers + D1 + R2 + GitHub Actions 計算層 +
  DuckDB-WASM ブラウザ計算。docs/13 の予算表と実装が一致
- **自己修復機構**: jobs/eval_runs の stuck-reap、dq_issues 自動解決、リトライキュー

### 1.2 実装済みだが問題があるもの

- ライフサイクルゲートに構造的バグ3件が連鎖していた (S-94/95/96、修正済み)。根本原因は
  eval_metrics の metric/segment 名の書き込み側 (Python) と読み取り側 (TS) に契約テストが
  無いこと。DSLには golden vector があるのに metric 名には無い、という非対称が残る
- UIが設計書 (docs/06) の劣化版だった (S-97/98 で一部解消)

### 1.3 設計は存在するが未実装のもの (本書の主対象)

| 設計 | 場所 | 状態 |
|---|---|---|
| Discovery Engine Stage 1–5 | docs/04 §5 | 完全未実装。`discovery_findings` テーブルと `/internal/findings` だけ存在し、書き込むジョブが無い |
| Research Pack 7種のうち6種 | docs/07 §2 | 未実装 (`daily_briefing` のみ) |
| 変換文法による feature 定義の spec 化 | docs/04 §3.2 | registry.py は Python ラムダ直書き |
| Cmd-K パレット / Feature カタログUI / Screen Config | docs/06 | 未実装 |

## 2. 設計の問題点

- **P-1. 「検証工場」は建ったが「仮説の翻訳機」が無い。** EEPは完全自動なのに、
  研究の実コストである仮説→SignalSpec→feature特定の翻訳が全手動。docs/04 の
  「ループB (データ駆動)」が未実装のため、ループA (人間が全部書く) しか存在しない
- **P-2. Feature 語彙が16本で、表現可能な Edge 空間が狭すぎる。** しかも語彙はUIの
  どこにも表示されず、研究者は Python ソースを読まないと「何が書けるか」を知り得ない。
  実装待ち36件の大半は「この語彙では書けない」ことが原因
- **P-3. DSLという最強の共通言語が SignalSpec 専用に閉じている。** BoolExpr は
  (a)機械可読 (b)二言語評価器 (c)依存抽出 (d)golden vector 保証、という理想的な
  中間表現なのに、使い道が JSON 手書きの一箇所だけ。Explorer の条件、discovery finding、
  AI生成仮説 — 全て同じ BoolExpr で表現できるのに、そうなっていない
- **P-4. REJECT が行き止まり。** verdict.py は reasons を構造化して返すのに、その先が無い。
  `improvement` pack が未実装のため、全REJECTの現状で研究者は次の一手を得られない
- **P-5. 不要・時期尚早なもの**: Portfolio タブ / edge_correlations (ADOPT 0件では無意味)、
  kasotubot 連携 (S-20 で正しくゲート済み)、HMM レジーム、Reports/Settings 画面、
  `decay_investigation` pack。Phase RS5 まで凍結

## 3. UX の問題点

- SignalSpec = 生JSONテキストエリア。語彙も文法も補完されず、featureスペルミス→
  READY判定ずれ、という事故が構造的に起きる
- Readiness は診断名を言うが処方箋を出さない (「FEATURE待ち: ls_top_trader_z_30d」の
  先の行動がUIに無い)
- Explorer は「SQLが書ける人向けの分布ビューア」。forward return との結合が無く、
  研究に使えない
- literature_import は「JSONを書かせるフォーム」。Pack が feature 語彙も DSL 文法も
  含まないため、AI は valid な spec を書けない
- グローバル検索 (Cmd-K) 無し。57件の Edge への到達手段が kanban スクロールのみ

## 4. 研究フローの問題点

- **F-1. 最も高コストな作業が最も早い関門に置かれている。** IDEA→CANDIDATE ゲートが
  signal_spec 存在を要求 (`guardIdeaToCandidate`)。安い探索 (条件当て) を先に、
  重い形式化を後に、が正しい順序
- **F-2. 反復コストが高すぎる。** REJECT→変更→新version→再screen のループが
  JSON手書き経由で1周数十分。誠実な研究は大量の棄却を前提とするので、
  **「1回の誠実な試行あたりのコスト」が本当のKPI**
- **F-3. AIとの往復が「1 Edge 1往復」で終わる。** 入口 (literature_import) と状況報告
  (daily_briefing) しか無く、研究の中盤 (「REJECTされた。なぜ? 次は?」) でAIを呼ぶ導線がゼロ

## 5. AIを組み込んだ理想の研究フロー

### 設計原則 (既存の強みを壊さない)

1. **AIハンドオフ (¥0) 構造は維持**。「AIファースト」= API常時接続ではなく、
   Pack を双方向・高密度・遍在にすること。API モード (BYOK) は Phase RS5 のオプション
2. **BoolExpr を全系統の共通言語にする**。AI出力も、Explorer 条件も、discovery finding も
   全部 BoolExpr。検証・依存抽出・READY 判定が既存コードでそのまま効く
3. **AIに語彙を渡す**。Pack に「現在の feature カタログ + DSL 文法 + 閾値慣習」を
   同梱すれば、AIは実行可能な spec しか書かなくなる
4. **決定論でできることをAIにやらせない**。Feature 充足判定・Readiness・IC 計算は決定論。
   AIは仮説生成・経済的接地・反証にのみ使う (docs/07 の原則堅持)

### 理想の1日

```
朝、Todayを開く
├─ ① 昨夜のDiscovery findings上位5件 (FDR q<0.10、AIレビュー待ち)
├─ ② REJECT済みEdgeのうち improvement Pack が用意できたもの2件
├─ ③ READY (今すぐscreen可能) 3件 → [まとめてscreen]
└─ ④ 論文を読んだ日: literature Pack v2をコピー → Claudeに論文と一緒に投げる
      → 返ってきたJSONを1回貼るだけで Edge+spec 3案+feature充足レポートが登録される

夕方: screen結果がAction Queueに載る → 合格ならワンクリックでTESTING → full自動
REJECTなら: [Copy for AI] improvement Pack → 「DSR 0.4で落ちた。試行予算残12。次の1手は?」
```

### 要求①〜⑥への対応表

| 要望 | 実現方式 | カード |
|---|---|---|
| ① AI Research Assistant | literature_import Pack v2 (語彙同梱、Edge+spec複数案+feature gapを単一JSONで往復) | S-103 |
| ② AI SignalSpec Generator | 同Pack内で複数案 (precision/recall/論文忠実)。貼り戻し時にzod検証+READY判定即表示 | S-103 |
| ③ Feature Recommendation | 決定論: Feature Catalog API (定義+データ充足+IC) + spec lint。AIは新feature定義の提案のみ | S-101 |
| ④ Readiness Advisor | nextActionLabel を処方箋に拡張 (チップのリンク化+improvement Pack導線) | S-104/105 |
| ⑤ Explorer | Signal Lab へ再設計。条件ビルダーの出力を SQL ではなく BoolExpr にし「SignalSpecへ昇格」を1クリック化 | S-106/107 |
| ⑥ AI Edge Discovery | docs/04 Stage 1+2 の実装。findings → finding_review Pack → 経済的接地をAIが判定 → 接地できたものだけ IDEA 昇格 | S-108/109 |

## 6. 画面ごとの改善案

### Explorer → Signal Lab
- 前提工事: features parquet に fwd_ret 列 (S-100)。これが無い限り Explorer は研究に使えない
- タブ1: Feature ランキング (feature×horizon の Spearman IC、分位スプレッド、n、年別安定性)
- タブ2: 条件ワークベンチ (GUI で BoolExpr → 条件付き forward return 分布 vs 無条件、
  [SignalSpecへ昇格] ボタン)
- タブ3: 既存の SQL 自由記述 (上級者用に残す)
- ガードレール表示: 「この探索は非公式。正式な検定は screen で行われ試行台帳に記録される」
  バナー + 現在の n_trials 表示
- MI (相互情報量) は Phase RS4 以降 (IC と分位スプレッドで実用上の大半をカバー)

### literature_import → Import Studio
- Pack v2 生成ボタン (feature カタログ・DSL 文法・カテゴリ一覧を自動同梱)
- 貼り戻しは `literatureImportV2Schema`、取込結果画面に spec 案ごとの READY バッジ

### Research Readiness → Readiness Advisor
- 不足チップをクリック可能に (Feature→カタログ、Data→Data Health、SignalSpec→Import Studio)
- FULL_DONE (REJECT) に [Copy for AI] improvement Pack

### SignalSpec → GUI + AI生成の両方 (二者択一にしない)
- Spec Builder (GUI): BoolExpr ツリーエディタ。7ノードしかない今が GUI 化の適期。
  文法拡張 (S-17) より先にエディタを作れば、以後の拡張はエディタに1ノード足すだけ
- AI生成: Import Studio 経由。GUI は AI 案の微修正にも使う

### Today → 研究キュー
- Action Queue に研究アイテム3種 (新findings上位 / improvement可能なREJECT /
  READYでscreen未実行) を統合し、「今日やる研究」が朝5分で決まる画面に

### Edge Board
- Cmd-K パレット、IDEA 列の readiness_class フィルタ

## 7. ロードマップ (Phase RS1〜RS5)

| Phase | 目的 | カード |
|---|---|---|
| RS1 反復コスト最小化 | fwd_ret 列 / Feature Catalog / Spec Builder GUI / metric名契約テスト | S-100, S-101, S-102, S-110 |
| RS2 AIファースト取込 | literature Pack v2 + 取込API / Import Studio / dossier・improvement Pack / Readiness Advisor | S-103, S-104, S-105 |
| RS3 Signal Lab | Feature ランキング / 条件ワークベンチ / 昇格動線 | S-106, S-107 |
| RS4 Discovery Engine v1 | Stage 1 (条件走査+BH-FDR) nightly / Findings Inbox / finding_review Pack | S-108, S-109 |
| RS5 Research OS 化 | Today 研究キュー統合 / クロス銘柄頑健性 / レジーム条件付き verdict / BYOK API モード / (ADOPT後) kasotubot・Portfolio 解凍 | 未起票 |

**捨てる/凍結するもの**: HMM、decay_investigation Pack、Reports/Settings 画面、
5m足以下、遺伝的探索 (docs/04 が正しく不採用済み)。

実装順は S-100 → S-101 → S-102 (全ての後続の前提)。各カードの実装粒度の詳細は
docs/19 Phase RS 節を正とする。
