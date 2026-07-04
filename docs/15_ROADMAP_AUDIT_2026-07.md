# 15. ロードマップ監査 (2026-07) — docs/09 との差分と次期実装タスク

本書は docs/09 (開発ロードマップ) を正典として、2026-07 時点の実装状態を監査し、
**ロードマップから逸れないための優先順位付き実装タスク** (Sonnet ハンドオフ用) を定義する。
docs/14 (Edge Pack v1) のフェーズ計画との接続も明記する。

---

## 1. 監査サマリ

| docs/09 フェーズ | 状態 | 備考 |
|---|---|---|
| Phase 0: 基盤 | ✅ 完了 | モノレポ / CI / D1 migration 0001–0006 / packages-schema / quota 監視 (収集・API・UI 表示まで) |
| Phase 1: 収集 | ◑ 部分完了 | Worker/Cron/リトライ/Telegram/DQ 骨格は稼働。**アダプタが 11 本中 6 系統のみ**。Data Health API/画面なし |
| Phase 2: 評価エンジン | ✅ ほぼ完了 | EEP full/screen・DSL 評価器 (Py/TS + golden 一致)・verdict・ルールレジーム・workflows 4 本すべて稼働 |
| Phase 3: シード検証 + UI | ◑ 部分完了 | 54 件シード投入済み・Today/Board/Dossier 稼働・Research Readiness 稼働。**P0 シード 5 件の検証・Research Pack・Data Health 画面・Explorer・ペーパートレードが未着手** |

### V1 Definition of Done の充足状況 (docs/09 §2)

| # | DoD 項目 | 状態 | ブロッカー |
|---|---|---|---|
| 1 | 全 tier 収集 7 日間無人・品質スコア ≥ 99% | ⚠️ 測定不能 | 収集は稼働中だが品質スコアを見る Data Health API/画面が無い |
| 2 | quota_usage 7 日実測が docs/13 §1 予算内 | ⚠️ 未検証 | 記録はある。7 日分の実測レポートを出していない |
| 3 | P0 シード 5 件に verdict / 朝のループ / 再現性 8 点 | ❌ 未達 | P0 シードの edge_version が未作成 (full run 0 件) |
| 4 | daily_briefing Pack を Claude に貼って解析できる | ❌ 未達 | docs/07 (Research Pack / Copy for AI) が丸ごと未実装 |

**結論: V1 完了に足りないのは「Research Pack」「P0 シード検証」「Data Health」の 3 つの P0 と、
収集アダプタの残り (特に後から取り直せない派生データ) である。**

---

## 2. 差分詳細

### 2.1 実装済み (ロードマップどおり)

- ingest Worker: tick スロット (5m/1h/1d/weekly)、ingest_tasks リトライ、429 対応、Telegram 通知、連続エラー検知、quota アラート
- アダプタ: okx (candles/funding/OI)、deribit (DVOL)、alternative_me、yahoo_finance (CME gap)、etherscan (USDT mint)、econ_calendar (器のみ・データ空)
- research: EEP full/screen 差別化、DSL 評価器 (Py)、walk-forward、DSR、permutation、verdict、Feature Store (価格系 + funding/OI/liq 系 registry)、deriv_sync (binance.vision バックフィル)、lake_sync (R2)、backup、nightly (ルールレジーム → regimes_daily)
- ingest 側 DSL 評価器 (TS) + golden テスト一致 (`packages/schema/fixtures/dsl-golden.json`)
- workflows: research-daily / research-weekly / research-on-demand / lake-sync
- API: edges CRUD + `/versions` + `/eval` + `/transitions` + readiness + `/internal` 一式 + `/ops/quota`
- UI: Today (市況 + quota + Readiness サマリ)、Edge Board (lifecycle/Readiness ビュー + フィルタ)、Edge Dossier (V1 スライス + 評価履歴 + 評価トリガー + Readiness パネル)
- シード: PDF 54 件投入済み。Edge Pack v1 (docs/14) Phase 1 として 5 件 screen 評価済み (全 REJECT)
- Research Readiness (docs/06 §7): 判定ロジック・API・UI 3 画面 + `edges.readiness_class` (A7/B7/C31/D5) 本番反映済み

### 2.2 未実装 (ロードマップの残り)

| 項目 | docs/09 上の位置 | 優先度 | 現状 |
|---|---|---|---|
| Research Pack + [Copy for AI] + 貼り戻し | Phase 3 / §6 P0 | **P0** | docs/07 §2–4 が丸ごと未実装 (ai_outputs への書き手が nightly の regime のみ) |
| P0 シード 5 件の full run → 初 verdict | Phase 3 / §6 P0 | **P0** | signal_spec/edge_version 未作成。cme_gap / usdt_mint イベントは Event Engine v1 で供給済み |
| Data Health API + SCR-05 | Phase 1–3 / §6 P0 | **P0** | dq_issues/ingest_state はスキーマのみ。品質スコア算出・画面なし |
| long_short_ratios / liquidations_5m のライブ収集 | Phase 1 (§7 で follow-up 明記) | **P0 相当** | `schedule.ts` STREAMS_1H の TODO のまま。**今日から貯めないと恒久欠損** (LS 比率はどの無料ソースも履歴を出さない) |
| ペーパートレード開始 (paper_signals writer) | Phase 3 / §6 P1 | P1 | writer が全コードベースに存在せず (docs/14 §6 で指摘)。PAPER→ACTIVE ゲートが永遠に満たせない |
| 残アダプタ (coinbase, defillama, fred, farside_etf, coinmetrics, tronscan) | Phase 1 | P1 | 未実装。ただしいずれも**履歴を後から取得できる**ソース (下記 §3.1 の逸脱判断) |
| econ_calendar 実データ投入 | Phase 1 | P1 | アダプタは no-op 稼働中。FOMC/CPI/NFP/PPI の検証済み日付が未投入 (docs/14 Phase 3 のブロッカー) |
| Today の Action Queue + テンプレブリーフィング表示 | Phase 3 / §6 P1 | P1 | 未実装 (Research Pack と同根) |
| Explorer 最小版 (DuckDB-WASM) | Phase 3 / §6 P1 | P1 | 未実装 |
| SCR-06 Reports / SCR-07 Settings | docs/06 | P2 | 未実装 (§6 の P0/P1 に含まれないため後回しで整合) |
| Discovery Stage 1–3 / findings UI / HMM / 相関ポートフォリオ | V2 / §6 P2 | P2 | 未実装 (V1 スコープ外 — 正しい) |

### 2.3 データ実在性の既知ギャップ (Readiness の DATA 待ちの根拠)

| テーブル | 状態 | 影響 |
|---|---|---|
| open_interest | 2026-07 以降のライブのみ (binance.vision の metrics バックフィルが実質未達) | liq-cascade-rebound (EC-006)、docs/14 の OI 依存 2 件が DATA 待ち |
| long_short_ratios | 0 行 (収集アダプタ自体が無い) | `ls_*` feature 全部が DATA 待ち |
| liquidations_5m | バックフィル分のみ・ライブ収集なし | 前方データが貯まらない |
| events (econ_calendar) | 0 行 | docs/14 Phase 3 (マクロ 3 件) がブロック |
| options_surface (VRP) | 収集なし | vrp-monitor は V1 では IDEA 維持 (docs/09 §3) なので予定どおり |

---

## 3. ロードマップからの逸脱の記録と判断

### 3.1 既に発生した逸脱 (記録)

1. **binance_rest → okx へ代替**: 収集第 1 陣の主取引所が geo 制約により OKX に置換済み。
   スキーマ・feature は取引所非依存なので設計影響なし。docs/03 の記述とはズレるため、いずれ docs/03 に注記する。
2. **Edge Pack v1 Phase 1 (docs/14) を P0 シード 5 件より先に評価**: 当時 P0 シードのうち
   イベント依存 2 件の Event Engine が未完だったため、ゼロコストで評価可能な別 5 件を先行させた。
   Event Engine v1 が完成した現在、**P0 シード検証に戻るのが docs/09 準拠** (本書 SONNET-3)。
3. **Research Readiness の追加**: docs/09 に無い機能だが docs/06 §7 として設計を先に更新してから
   実装したため、設計書と実装は一致している (逸脱ではなく設計改訂)。

### 3.2 本書での唯一の順序変更とその理由

素朴に読めば「Phase 1 の残アダプタ全部 → Phase 3 の残り」だが、本書は
**「後から取り直せないデータのライブ収集」だけを先に、「履歴を後から取得できるアダプタ」を P1 後半に**置く。

- 根拠: docs/09 §1 の ROI 根本原理そのもの — 「データは今日から貯めないと永久に手に入らない」。
  LS 比率・清算のライブ供給は無料ソースに履歴が無く、待つほど恒久欠損が増える。
  一方 FRED / DeFiLlama / farside / coinmetrics は全履歴を API が返すため、遅らせても失うものが無い。
- デメリット: マクロ・オンチェーン系 Edge (分類 C) の評価開始が数週遅れる。
  ただし分類 C はどのみち Feature 追加も必要で、evaluable になる時期は大差ない。

---

## 4. Sonnet ハンドオフ: 優先順位付き実装タスク

実装規約 (全タスク共通):
- 既存アーキテクチャに統合する (新パターンを発明しない)。参照: docs/01–08、`workers/ingest/src/schedule.ts` のアダプタ登録方式、`apps/api/src/routes/` の Hono ルート方式
- edge_version / job の作成は **必ず API (`POST /api/v1/edges/:id/versions`, `/eval`) 経由**。
  D1 直接投入は Edge Pack v1 Phase 1 限りの一時対応であり恒久フローに含めない (ユーザー指示)
- 各タスク完了時: `pnpm turbo run typecheck test lint` 緑 → コミット → push → deploy.yml の
  「Apply D1 migrations」まで成功確認 (smoke test の 302 失敗は既知・無視)

### SONNET-1 (P0): long_short_ratios / liquidations_5m のライブ収集アダプタ

- **理由**: 後から取り直せない唯一のデータ。1 日遅れるごとに恒久欠損が増える (§3.2)
- 内容: `workers/ingest/src/adapters/` に OKX (または Binance futures data endpoints のうち geo 制約を通るもの) の
  long/short account ratio・liquidation アダプタを追加し、`STREAMS_1H` の TODO を解消。
  書き込み先は既存の `long_short_ratios` / `liquidations_5m` (internal API 契約は TASK-3 で実装済み)
- 受入条件: 本番 D1 で両テーブルに新規行が毎時増えること。quota 予算 (docs/13 §1) 内であること
- 完了で解除されるもの: `ls_*` feature の DATA 待ち (前方データ蓄積開始)、docs/14 の保留 2 件の将来評価

### SONNET-2 (P0): Research Pack + [Copy for AI] (docs/07 §2–4)

- **理由**: V1 DoD #4 を満たす最後の P0 機能。AI ハンドオフ方式は本プロジェクトの中核思想
- 内容:
  1. Pack テンプレート (`apps/api/src/packs/`) + `pack_version` 付与、daily_briefing Pack の生成 (research-daily ジョブ内で AI なしテンプレ生成 → `ai_outputs` へ)
  2. `GET /api/v1/packs/...` (docs/08 に追記) + Today 画面に [Copy for AI] ボタン
  3. 貼り戻し (双方向スキーマ docs/07 §2) の最小版: 貼り付け → zod 検証 → 対象テーブル反映
- 受入条件: Today からコピーした Pack を Claude に貼って解析できる。貼り戻しが 1 種類以上動く

### SONNET-3 (P0): P0 シード 5 件の検証 (docs/09 §3 のとおり)

- **理由**: V1 DoD #3。Event Engine v1 完成により前提が揃った
- 内容 (すべて API 経由。D1 直接投入禁止):
  - cme-gap-fill (EC-021): event: cme_gap の signal_spec → `POST /versions` → full run
  - utc-2123-drift (EC-018): time + trend レジーム条件 → full run (regimes_daily は nightly が供給済み)
  - usdt-mint-drift (EC-031): event: usdt_mint (≥$1B) → full run
  - liq-cascade-rebound (EC-006): OI/清算履歴不足のため **DATA 待ちとして登録のみ** (SONNET-1 + 履歴蓄積後に評価)
  - vrp-monitor (EC-013): docs/09 どおり IDEA 維持 (観測のみ)。作業なし
- 受入条件: 3 件に verdict が付き Dossier で見えること。結果一覧 (発火回数/EV/Sharpe/DSR/p_perm/Verdict) を報告
- 注意: 検証結果による状態遷移はユーザー判断。評価と報告まで

### SONNET-4 (P0): Data Health API + SCR-05 (docs/06 §3)

- **理由**: V1 DoD #1 (品質スコア ≥99%) が測定不能な状態を解消する
- 内容: `GET /api/v1/data-health` (ingest_state / dq_issues / data_sources / ソース別品質スコア) + web の Data Health 画面 (docs/06 SCR-05 のワイヤーフレームどおり)。品質スコア定義は docs/03 §6
- 受入条件: 画面でソース別の鮮度・エラー率・品質スコアが見え、7 日分のスコアが算出できる

### SONNET-5 (P1): ペーパートレード開始 (paper_signals writer)

- **理由**: Phase 3 の項目であり、これが無いと PAPER→ACTIVE ゲート (docs/05) が構造的に満たせない (docs/14 §6 指摘)
- 内容: ingest Worker の TS DSL 評価器 (`signals/dsl-evaluator.ts`) を tick に接続し、
  PAPER 状態 Edge の current version の when 成立時に `paper_signals` へ記録。約定/リターン確定はフォローアップ ジョブ
- 受入条件: PAPER に遷移させたテスト Edge でシグナル行が書かれること。Dossier に Paper タブ最小版

### SONNET-6 (P1): 残アダプタ + econ_calendar 実データ — 部分完了 (2026-07)

- **完了**: `ECON_CALENDAR` に 2026 FOMC 8件を投入 (WebSearch で複数独立ソースを突き合わせ、
  全て一致する日付のみ採用)。docs/14 Phase 3 の pre-fomc-drift / sell-the-news-fomc-drift の
  ブロッカーを解除。CPI/NFP/PPI は BLS の年間全日程をこの環境から検証できなかったため
  (2ヶ月分のみ確認) 意図的に空のまま — 捏造しない方針を優先
- **未着手** (この回では見送り、理由を明記): fred / defillama / farside_etf / coinbase /
  coinmetrics_community / tronscan の6アダプタ。理由: (1) このサンドボックス環境は任意ホストへの
  外向きネットワークがプロキシで遮断されており (`curl` で `stablecoins.llama.fi` 等も403)、
  実際の応答スキーマを事前検証できない — OKX (SONNET-1) で2回連続、本番tickで初めて判明した
  スキーマ不一致 (`instId`→`instFamily`、`details`省略) を踏まえると、6本を未検証のまま一度に
  投入するのは本番での連鎖的な障害リスクが高い。(2) fred/tronscan はAPIキーが必要で
  このセッションには設定されていない。(3) farside_etf はHTMLスクレイピングで実装コストが大きい。
  (4) coinmetrics_community は約40系列と規模が大きい。
- **次アクション**: 6アダプタは1本ずつ個別タスクとして着手し、デプロイ後の本番tickで
  スキーマを検証・修正するサイクル (OKXで確立した手順) を踏む方が安全。次点候補は defillama
  (キー不要、`stable.usdt_mcap`/`stable.total_stable_mcap` の metric_defs は既に登録済み)
- 受入条件 (未達成分): 各テーブルにデータが入り Data Health (SONNET-4) で品質スコアが見えること

### SONNET-7 (完了): Today 完成 (Action Queue + テンプレブリーフィング表示)

- `GET /api/v1/actions` を実装: SCREEN_DONE/FULL_DONE Edge (承認待ち/レビュー待ち) + open DQ critical
  issue を単一キューとして返す。findings 由来の項目は Discovery Engine 未実装のため対象外 (V2)
- Today 画面に Briefing パネル (Pack本文表示 + 折りたたみ + Copy for AI) と Action Queue パネルを追加。
  jobs ベースの項目 (docs/06 原案) ではなく Readiness state ベースにした — jobs テーブルは
  screen/full 実行キューであって「人間のレビュー待ち」を直接表さないため、Readiness (SONNET-4以前に
  実装済み) の SCREEN_DONE/FULL_DONE を項目源にする方が実データと一致する
- Portfolio Pulse は未実装のまま据え置き (paper_signals 母数が少ないうちは無意味、docs/09 P2の
  相関/ポートフォリオ機能と合わせて実装する想定)
- typecheck/test/lint 全緑 (api 73テスト)、**本番デプロイ成功確認済み** (`cfea22a`)。本番D1の
  読み取り確認: SCREEN_DONE/FULL_DONE 相当の run が実在 (utc-2123-drift の full×2、
  funding-rate-mean-reversion の full×1 等) しており Action Queue に実データが乗ることを確認。
  ただし open DQ critical issue 10件は okx_rest 移行前の廃止済みストリーム (binance_rest/coingecko)
  の古い issue で、実質ノイズ — dq_issues の解決フロー (`status='resolved'`遷移) がまだ無いための
  副作用であり、SONNET-7のスコープ外の別課題として記録のみ

### SONNET-8 (P1): Explorer 最小版 (DuckDB-WASM)

- 内容: docs/06 SCR-04 の Explorer 部分のみ — R2 Parquet カタログ + 条件式 + 分布図 (docs/09 §7: 2–3 日想定)
- 受入条件: ブラウザから R2 の Parquet に対しアドホッククエリと分布図が出せること

### V1 完了ゲート (タスクではなく検証)

SONNET-1〜4 完了後、7 日間の無人運転で DoD 4 項目を実測し、docs/09 §2 の表に対する充足レポートを作成する。
これが通れば V1 完了宣言。docs/14 の Phase 2 以降 (weekly feature 追加 → マクロ 3 件 → VRP → DSL 拡張) は
V1 完了後に、SONNET-1/6 で解除される DATA 待ちの状況と合わせて再スケジュールする。

---

## 5. 本書の位置づけ

- docs/09 が引き続きロードマップの正典。本書は 2026-07 時点のスナップショット監査 + ハンドオフ指示書
- 逸脱は §3 に記録したもののみ。以後の逸脱も本書の様式 (理由・差分・メリデメ) で追記する

## 6. 実行ログ (SONNET-1〜3, 2026-07-04)

### SONNET-1 (完了): long_short_ratios / liquidations_5m ライブ収集

- OKX rubik long/short 比率アダプタ、liquidation-orders 清算アダプタを実装・デプロイ (`15ca993`)
- 本番初回 tick-1h (13:15 UTC) で **long_short_ratios は成功** (2行書き込み)。
  **liquidations_5m は HTTP 400** — OKX の `liquidation-orders` は `instType=SWAP` に対して `instId` フィルタを受け付けず `instFamily` が必要と判明 (本番実データで発見)。`fe89c05` で修正・デプロイ
- 2回目の tick-1h (14:15 UTC) で HTTP 400 は解消したが `group.details is not iterable` で新規失敗 —
  同一 instFamily 内で当該インスツルメントの約定が無いグループは `details` を省略して返すことが判明。
  `3b258f7` で修正・デプロイ済み
- 3回目の tick-1h (15:15 UTC) で **正式に成功を確認**: `liquidations_5m` 157行書き込み、
  `ingest_state.last_status='ok'` (両インスツルメント)。`long_short_ratios` も継続して正常。
  **SONNET-1 完全完了**

### SONNET-2 (完了): Research Pack V1 slice

- daily_briefing Pack 生成・[Copy for AI]・貼り戻しフォームを実装・デプロイ (`92c918d`)
- research-daily.yml 手動実行で実際に Pack が生成され `ai_outputs`/R2 へ登録されることを本番で確認済み

### SONNET-3 (状況確認のみ、新規実装なし): P0 シード3件

**認証上の制約**: `POST /api/v1/edges/:id/versions` `/eval` は Cloudflare Access 必須のミューテーションで、
このエージェントセッションから直接実行できない。Phase 1 の D1 直接投入は「今回のみの一時対応」と
明示されているため再利用せず、既存の edge_version/eval_runs 状態を読み取り専用で確認するに留めた。

**確認できた実態** (3件とも edge_version は既に存在し signal_spec は docs/09 §3 どおり正しい — 新規作成不要):

| Edge | 状態 | 詳細 |
|---|---|---|
| utc-2123-drift (EC-018) | **評価済み** | screen×2・full×2 が既に完了 (完了時刻 2026-07-04 00:20〜07:02 UTC、本セッション外)。最新 full run: EV=-6.99bps, Sharpe=-1.58, DSR≈0.0000275, p_perm=0.18 → **REJECT** |
| cme-gap-fill (EC-021) | **評価不可 (ブロック)** | screen/full とも `signal_spec references event type(s) not available in the fetched data: ['cme_gap']` で失敗 (直近試行 09:43 UTC)。`events` テーブルに `cme_gap` 行が0件 |
| usdt-mint-drift (EC-031) | **評価不可 (ブロック)** | 同様に `usdt_mint` イベント0件で失敗 (直近試行 13:08 UTC) |

**根本原因 (バグではなく想定挙動)**: cme_gap/usdt_mint/econ_calendar の3アダプタは `STREAMS_1D` 所属で
1日1回 (01:20 UTC) しか発火しない。`ingest_state` にはこの3アダプタの行が一切無く
(`alternative_me` のみ 'ok') — TASK-4 のデプロイが当日の 01:20 UTC 発火より後だったため、
デプロイ後まだ一度も実行機会が無かったと判明。翌日 01:20 UTC 以降に初回実行されるが、
そこから実際に CME ギャップ (週末) や $1B 級 USDT mint が観測されるまではさらに時間を要する。

**次アクション**: cme-gap-fill/usdt-mint-drift の再評価は、events テーブルに該当イベントが
最低数件溜まってから (数日〜) 行うのが妥当。今 job を再投入しても同じ理由で失敗するだけなので
見送った。utc-2123-drift の REJECT 結果は正式な V1 DoD #3 実績として記録済み (3件中1件完了、
2件はデータ蓄積待ち)。

### SONNET-4 (完了): Data Health API + SCR-05

- `GET /api/v1/data-health` + Data Health 画面を実装・デプロイ (`abf4053`)。V1 DoD #1 の
  「品質スコア測定手段が無い」を解消
- 品質スコアは docs/03 §6 の30日ローリング値の近似 (ingest_state に履歴が無いため、Readiness と
  同じ「都度計算・保存しない」方式)。typecheck/test/lint 全緑、本番デプロイ成功確認済み

### SONNET-5 (完了): paper_signals writer

- `workers/ingest/src/signals/paper-trading.ts` を実装し tick-5m に接続。docs/14 §6 が指摘した
  「`paper_signals` に書き込み処理が存在しない」を解消 — PAPER→ACTIVE ゲート (docs/05 §2) が
  構造的に満たせなかった問題への対応
- V1 スコープ: `when` に feature (`cmp`) 参照が無い (event/regime/time のみ)、
  `entry.delay_bars<=1`、固定 `exit: {horizon}` のみサポート。Feature Store の値は R2 Parquet
  にしかなくこの Worker からライブ読み取りできないため — 該当しない Edge は毎tickスキップ
  (ログのみ、フェイルクローズ、フォールバック値の捏造なし)
- ret_bps/round-trip-cost の計算式は research/eval/backtest.py と同一 (PAPER と FULL の比較可能性
  を保つ)。direction/horizon は edge_versions の列 (signal_spec 内の重複コピーではなく) を使用 —
  on_demand.py の参照元と揃える
- Edge Dossier に Paper タブ最小版 (`GET /edges/:id` の `paper_signals[]`) を追加
- 本番にはまだ PAPER 状態の Edge が存在しないため、実データでの動作確認は未実施。単体テスト
  (FakeD1 バックエンド、13件) で検証済み。typecheck/test/lint 全緑

### バグ修正: Data Health が恒久停止ソースを問題として表示 (2026-07, ユーザー報告)

- 現象: 本番の Data Health 画面で全体品質スコアが 59.1% と表示され、`binance_rest` の全ストリームが
  0%・連続エラー40・open issueありとして表示されていた (実機スクリーンショットで発見)
- 原因: docs/03 §2.1 で「2026-07 に運用中止」と明記済みの `binance_rest`/`bybit_rest`/`coingecko`
  (Cloudflare Workers 共有 egress IP への WAF ブロックで恒久的に到達不能) が、`data_sources.status`
  列では `'active'` のままだった。Data Health (SONNET-4) の品質スコア計算がこれを他の現役ソースと
  区別せず平均に含めていた
- 修正: `migrations/0007_retire_blocked_sources.sql` で該当3ソースを `status='disabled'` に更新。
  `computeDataHealth` は disabled ソースのストリームを `overall_quality_score` と `open_issues` から
  除外 (ストリーム自体は「無効化済みソース」として折りたたみ表示に残す)。Data Health 画面も
  disabled ソースを下部の折りたたみへ分離。api 74テスト・typecheck/lint 全緑

### SONNET-8 (完了): Explorer 最小版 (DuckDB-WASM)

- バックエンド: `apps/api/src/routes/lake.ts` — `GET /api/v1/lake/catalog` (curated/・features/ 配下の
  R2 キー一覧) と `GET /api/v1/lake/*` (Range リクエスト対応の R2 パススルー、immutable キャッシュ)。
  docs/08 の事前設計どおり。api 79テスト (新規5件)・typecheck/lint 全緑
- フロントエンド: `@duckdb/duckdb-wasm` を追加し `apps/web/src/lib/duckdb-lake.ts` でブラウザ内
  DuckDB を初期化。`ExplorerScreen` はカタログからデータセットを選択 → `DESCRIBE` で列一覧取得 →
  WHERE句 (自由記述SQL) + 分布を見る列を指定 → 件数/min/max/avg/stddev + ヒストグラムを描画。
  すべてクライアント側で完結 (docs/01 §3.3)。router/nav に `/explorer` を追加
- ブラウザ実機検証: `wrangler dev --local` (ローカルD1/R2) + `vite dev` + Playwright (Chromium) で
  実施。カタログ取得→データセット選択→DuckDB-WASM初期化 (worker生成・wasmインスタンス化) →
  `read_parquet` 呼び出しまでは実機で確認できたが、DuckDB-WASM 1.x は `parquet` エクステンションを
  `extensions.duckdb.org` からオンデマンドで取得する設計のため、**このサンドボックスの outbound
  プロキシがそのホスト (および cdn.jsdelivr.net・unpkg.com のミラーも含め) を 403 でブロックする**
  ことが判明 (`curl --proxy` で個別確認済み)。これはサンドボックス固有のネットワーク制限であり、
  実際のユーザーブラウザ (無制限のインターネットアクセスを持つ) では標準的な duckdb-wasm 統合と
  同様に動作するはずだが、この環境内では Parquet の実データ読み取りまでは確認できていない
- 検証中に見つけたバグを修正: データセット選択時のエラー (`queryError`) が `columns` 存在時のみ
  レンダーされる条件分岐の内側にあり、選択直後に失敗すると画面が無反応に見えた。トップレベルにも
  エラー表示を追加して修正
- typecheck/lint/test (api・web) 全緑、`vite build` 本番ビルドも成功確認済み
