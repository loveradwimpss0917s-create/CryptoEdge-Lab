# 17. アーキテクチャ総監査 (2026-07-05, Chief Architect)

> **位置づけ**: リポジトリ全体 (コード / docs / D1本番データ / R2 / GitHub Actions / Cloudflare構成) を
> 実地に確認した監査記録。docs/15 (実装スナップショット監査 + 実行ログ) を引き継ぎ、以後の正典は
> docs/18 (Master Roadmap)・docs/19 (Sonnet実装計画)・docs/20 (kasotubot連携) に移す。
> **監査方法**: 全docs通読、apps/api・apps/web・workers/ingest・packages・research の主要ソース確認、
> 本番D1への読み取りクエリ (edges 55 / edge_versions 9 / eval_runs 15 / verdicts 14=全REJECT /
> events 8 (fomcのみ) / paper_signals 0 / open dq_issues 40 / options_surface 34)、deploy.yml 実行履歴。

---

## 1. 全体評価 — 何が正しく作られているか

このプロジェクトの土台は健全である。監査で確認できた強み:

| 領域 | 評価 | 根拠 |
|---|---|---|
| 統計エンジン (EEP) | ◎ | walk-forward (時間基準)・DSR・permutation・screen/full 差別化まで実装済み。全REJECTという結果自体が「ゲートが甘くない」ことの証拠 |
| DSL 2言語一致 | ◎ | Python/TS 両評価器 + golden vector 契約テスト (docs/11 §4 のとおり) |
| 無料枠設計 | ◎ | quota監視・tick スロット割付け・Cache API 方針が docs/13 どおり動作。実測も予算内 |
| フェイルクローズ文化 | ◎ | econ_calendar「捏造しない」、paper trading「該当しないEdgeはスキップ」、Access未設定時のmutation拒否 — 全て一貫している |
| 運用の自己記述性 | ○ | docs/15 実行ログ方式により「なぜこうなったか」が追跡可能。本監査もそれに依存できた |
| テスト | ○ | research 187 / api 79 / ingest 70。ただしweb 4件のみ (§4.7) |

**結論: 「作り直し」が必要な箇所は無い。** 以下の指摘はすべて増分改善であり、既存アーキテクチャの
延長線上で解決できる。

---

## 2. 設計と実装のズレ (docs vs 現実)

| # | ズレ | 影響 | 対応先 |
|---|---|---|---|
| Z-1 | docs/09 §3: vrp-monitor「V1は観測のみ、戦略化はV2判断」 vs docs/14 Phase 4 が前倒しを提案 | 未決定のまま両論併記状態 | ユーザー判断待ち (docs/19 S-19) |
| Z-2 | docs/14 §1.1「edge_versions 4件」→ 実際は9件 (Phase 1 の5件がD1直接投入で追加済み) | 記述が古いだけ、実害なし | docs/14 に注記1行 (docs/19 S-90) |
| Z-3 | docs/06 SCR-04 の Findings Inbox / Screen Config は未実装 | 意図的 (Discovery EngineはV2) — ズレではなく未着手 | docs/18 V2 |
| Z-4 | docs/02 §6「再現性8点」の記録運用が始まっていない | V1 DoD #3 の一部が測定されていない | docs/19 S-05 |
| Z-5 | instrument_id が `BTCUSDT.BINANCE.PERP` のまま実データ源はOKX | docs/03 §2.1 に注記済み・スキーマは取引所非依存なので設計どおり。ただし新規参加者は混乱する | docs/03 の注記を README からも参照させる (S-90) |
| Z-6 | deploy.yml の Smoke test が「毎回失敗」(302既知問題) | **CIの信号が常に赤** — 本物の失敗 (Asset too large事故など) との区別を人間の注意力に依存している。監査上これは最も安く直せる最重要項目 | docs/19 S-01 |

---

## 3. 技術的負債 (優先度順)

### 3.1 P0 — 研究の正しさ・速度を直接阻害しているもの

1. **イベント履歴の不在 (最重要)**。`events` テーブルは前方収集のみ (現在 fomc 8件のみ、
   cme_gap/usdt_mint は 0件)。EEP のバックテストは D1 の events を参照するため、
   **イベント系Edge (P0シードの cme-gap-fill / usdt-mint-drift、docs/14 Phase 3 の FOMC 2件) は
   歴史サンプルが無く、何年待っても n が貯まらない**。イベントは過去データから機械的に再構成できる
   (CME gap = yahoo BTC=F 履歴、usdt_mint = etherscan 履歴、FOMC = 公式過去日程) ので、
   これは「待つ」問題ではなく「バックフィルを書いていない」問題である。→ docs/19 S-03
2. **dq_issues にライフサイクルが無い**。`resolved_at` 列はあるが誰も resolve しない。
   未解決40件が累積し、Action Queue と Data Health のノイズになっている
   (SONNET-7 で記録済みの課題)。ストリーム回復時の自動resolveが本筋。→ S-02
3. **Feature Store のライブ読み取り手段が無い**。feature実値は R2 Parquet のみで、
   ingest Worker から読めない。結果、paper trading は `cmp` (feature参照) を含むEdgeを
   評価できない (docs/15 SONNET-5 の明記済み制約)。features_sync が最新1行を
   `latest_snapshots` へミラーするだけで解決する。→ S-16
4. **funding コストがバックテストに反映されない** (docs/14 §1.3)。funding保有系Edgeの
   経済性が系統的に歪む。CostModel への追加は小さい。→ S-17

### 3.2 P1 — 運用・信頼性

5. **deribit_rest:dvol の持続的 429** (監査時点で13時間連続)。binance_rest と同じ
   「Workers共有egress IPへの恒久ブロック」パターンの可能性がある。データ欠損バグ自体は
   修正済み (24hウィンドウ化, `b7c6090`) だが、**72時間ルール**を提案する:
   72h連続失敗が続いたら (a) 頻度を1dに落として再試行 → (b) それでもダメなら
   binance_rest と同じ retire 手順 (migration で disabled + docs/03 追記)。
   VRP系 (Z-1) の前提データなので、retireする場合はZ-1の判断も自動的に「不可」になる。→ S-06
6. **duckdb-wasm の実行時CDN依存**。Explorer は毎回 jsdelivr から wasm (~35MB) を取得する。
   可用性・プライバシー・将来のバージョンドリフトの三重リスク。**R2 に wasm/worker を置き
   既存の Lake パススルー (`/api/v1/lake/*` は curated/features 限定なので、`vendor/` prefix を
   許可リストに足すか専用ルート) から配信**すれば、25MiB Static Assets 制限 (f2ad81b の事故原因)
   を回避しつつ自己完結できる。→ S-22
7. **エージェント/CIからのAPI mutation不能**。Cloudflare Access はブラウザセッション前提のため、
   Sonnetセッション・GitHub Actions から `POST /versions` `/eval` が打てない (SONNET-3 で発覚、
   UIフォームで人間経由の恒久フローは確保済み)。**Access Service Token**
   (`CF-Access-Client-Id/Secret`) を導入すれば、kasotubot連携 (docs/20) と将来の自動化の
   両方が同じ仕組みで解決する。認証ミドルウェアへの追加は小さい。→ S-20
8. **wrangler v3 (v4警告が毎デプロイ出続けている)**。「critical errors を防ぐため更新せよ」
   という警告を無視し続ける状態は健全でない。→ S-21

### 3.3 P2 — 保守性・品質

9. **web のテストが4件のみ**。バージョン作成フォーム・Explorer・Action Queue 等の
   ロジックはノーテスト。少なくとも zod検証まわりとAPIクライアントのユニットテストを足す。→ S-23
10. **CI に turbo キャッシュ永続化が無い** (毎回 cache miss)。actions/cache で数分短縮可能。低優先。
11. **Explorer の実データE2Eが未確認**。Safari URL修正 → credentials修正まで2段の推測修正を
    重ねたが、本番ブラウザでの成功確認がまだ無い (docs/15 §8)。クローズアウトが必要。→ S-07

---

## 4. docs 監査 — 17本の現状と処遇

| doc | 判定 | 理由 / 対応 |
|---|---|---|
| 00_MASTER_PLAN | **維持** | 思想の正典。変更不要 |
| 01_ARCHITECTURE | **維持** | 実装と一致 (2 Workers + Actions + D1/R2/KV) |
| 02_DATABASE | 小修正 | 0002以降のmigrationで足した列/テーブル (readiness_class 等) の追記が一部漏れ |
| 03_DATA_SOURCES | **維持** | okx移行・retire済みソースの注記も反映済み |
| 04_EDGE_DISCOVERY | 維持 (V2待ち) | Discovery Engine未実装だが設計として有効 |
| 05_EDGE_EVALUATION | **維持** | EEP実装と一致 |
| 06_UI_UX | 小修正 | SCR-03 [新バージョンを作る] 実装済みの注記。SCR-04は Explorer のみ実装済みと明記 |
| 07_AI_INTEGRATION | **維持** | 実装状況注記が既に入っている |
| 08_API_SPEC | **維持** | 実装状況注記が全セクションに入っている。docs/20 実装時に signals/executions を追記 |
| 09_ROADMAP | **役割変更** | 「バージョン戦略と優先原理」の正典として維持。**タスク粒度の管理は docs/18 に移譲** (二重管理をやめる) |
| 10_RISKS | 維持 | 追記候補: CDN依存 (§3.2-6)、外部API恒久ブロックの再発 (deribit) |
| 11_TESTING | 維持 | web テスト薄い現状は §3.3-9 として本書に記録 |
| 12_OPERATIONS | 維持 | — |
| 13_FREE_TIER_PLAN | **維持** | 実測と整合 |
| 14_EDGE_PACK_V1 | 小修正 | §1.1 の件数が古い (Z-2)。Phase 2-5 のタスク管理は docs/19 へ移譲 |
| 15_ROADMAP_AUDIT | **凍結 (アーカイブ)** | SONNET-1〜8 完了により役割終了。§6-8 は貴重な実行ログなので削除せず「完結した監査ログ」として凍結。以後の追記は禁止し、docs/18/19 に書く |
| 16_SIGNAL_EVENT_INTERFACE | **維持・昇格** | docs/20 の契約層としてそのまま使う。open items 4件は docs/20 §3 で解決 |

**矛盾の一覧**: 実質的な矛盾は Z-1 (VRP前倒し判断) のみ。それ以外は「古い数値」か「未実装の将来設計」
であり、上表の小修正で解消する。**docsの重複は 09/14/15 のロードマップ3重管理が唯一の構造問題**で、
本監査により「09=戦略、18=ロードマップ正典、19=実装タスク、15=凍結ログ」に整理する。

---

## 5. 将来問題になる点 (今は顕在化していないもの)

1. **D1 サイズ**: 現在 ~3MB。candles 1m を D1 に貯め続けると数年で肥大する。設計上 R2 が
   長期保管でありD1は直近ウィンドウのみ保持する前提 (docs/02) だが、**古い行の削除ジョブが
   まだ存在しない**。V1.5 で retention ジョブを入れる (docs/19 S-18)。
2. **単一取引所依存**: 実データ源が実質 OKX のみ。OKX が binance 同様にWorkers IPを
   ブロックしたら収集が全停止する。docs/03 の V2 データ拡張 (bybit等) はこのリスクヘッジを兼ねる。
3. **verdicts 全REJECT問題**: 統計的には正しい挙動だが、「ADOPTが1件も無い」状態が続くと
   PAPER→ACTIVE→kasotubot の下流パイプライン全体が未検証のまま残る。docs/20 では
   シャドー運用 (K-2) を verdicts に依存させず開始できる設計にした。
4. **個人運用の属人性**: Cloudflare Access がユーザー1人のブラウザセッションに紐づく。
   Service Token 導入 (S-20) は自動化だけでなく「運用者が変わっても回る」ためにも必要。
5. **法的位置づけ**: シグナルを kasotubot へ渡し自動売買する段階で、docs/10 R-J3
   (投資助言該当性) の再確認が必要。**単一ユーザー・自己資金・自己運用に限定する限り問題は
   小さい**が、docs/20 に明記した。

---

## 6. アーキテクチャ決定record (本監査で確定する方針)

| ADR | 決定 | 理由 |
|---|---|---|
| ADR-1 | イベントは「前方収集 + 履歴バックフィル」の二本立てを正式仕様とする | §3.1-1。バックテスト可能性はこのプロジェクトの存在理由そのもの |
| ADR-2 | 機械間認証は Cloudflare Access Service Token に統一 (research-worker の Bearer /internal は現状維持、新規の機械クライアントは Service Token) | 1つの仕組みで kasotubot・CI・エージェントを賄える |
| ADR-3 | Explorer の wasm はR2自己ホストへ移行 | 実行時CDN依存の排除 (§3.2-6) |
| ADR-4 | ロードマップの正典は docs/18、タスクの正典は docs/19。docs/15 は凍結 | 3重管理の解消 (§4) |
| ADR-5 | kasotubot 連携は pull型 (kasotubotがポーリング) + 冪等イベントIDで開始する | Workers Free に Queues/Durable Objects が無い制約下で最も単純・確実 (docs/20 §4) |
| ADR-6 | 外部ソースが72時間連続失敗したら降格(頻度減)→retire の二段手順を標準化 | binance/deribitで繰り返したパターンの手順化 (§3.2-5) |
