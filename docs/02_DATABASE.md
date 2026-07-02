# 02. データベース設計 (D1)

> D1 = SQLite。型は `INTEGER` / `REAL` / `TEXT` / `BLOB`。
> 全時刻カラムは **epoch ミリ秒 (UTC) の INTEGER**。日付キーは `TEXT 'YYYY-MM-DD'` (UTC)。
> JSON カラムは `TEXT` に JSON 文字列 (packages/schema の zod で検証してから書込む)。
> マイグレーションは `migrations/0001_init.sql` から連番。**列の削除・型変更は禁止**、追加とテーブル新設のみ (SQLite の制約と履歴保全のため)。

## 1. 設計方針

1. **二時制 (bitemporal)**: 改訂されうる系列 (`metrics`) は `ts` (事象時刻) と `ingested_at` (取得時刻) の複合キーで全改訂を保持。バックテストは「`ingested_at <= as_of` の中で最新」を使う (ポイントインタイム再現)。
2. **専用テーブル vs 汎用テーブル**: 高頻度・複合値 (OHLCV, funding, OI, 清算, 板) は専用テーブル。スカラー日次/時間次系列 (オンチェーン・マクロ・センチメント・フロー・プレミアム) は汎用 `metrics` + レジストリ `metric_defs`。**新データソース追加時にスキーマ変更を不要にする**ため。
3. **物理削除禁止**: 研究系テーブル (edges, eval_runs, ...) は削除せず状態遷移。市場データは保持期間経過後 R2 へアーカイブしてから削除 (§5)。
4. **外部キー**: D1 で FK は有効化するが、参照整合の主防衛線はアプリ層 (zod + サービス層)。

---

## 2. テーブル定義

### 2.1 メタデータ系

#### `instruments` — 研究対象銘柄

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| instrument_id | TEXT | **PK** | 例 `BTCUSDT.BINANCE.PERP`, `BTCUSDT.BINANCE.SPOT`, `BTC1!.CME.FUT` |
| symbol | TEXT | NOT NULL | `BTCUSDT` |
| venue | TEXT | NOT NULL | `BINANCE` / `CME` / `DERIBIT` ... |
| kind | TEXT | NOT NULL | `spot` / `perp` / `future` / `index` / `option_index` |
| base, quote | TEXT | NOT NULL | `BTC`, `USDT` |
| tick_size, lot_size | REAL | | 表示・コストモデル用 |
| is_active | INTEGER | NOT NULL DEFAULT 1 | 0/1 |
| meta | TEXT | | JSON (取引所固有情報) |

Index: `(venue, symbol)`。保持: 永続。

#### `data_sources` — 外部ソースレジストリ (docs/03 §2 と 1:1)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| source_id | TEXT | **PK** | `binance_rest`, `deribit_rest`, `fred`, ... |
| name | TEXT | NOT NULL | 表示名 |
| tier | TEXT | NOT NULL | `free` / `freemium` / `paid` |
| base_url | TEXT | | |
| rate_limit | TEXT | | JSON `{per_min, weight_rules}` |
| requires_key | INTEGER | NOT NULL | 0/1 |
| tos_note | TEXT | | 利用規約上の注意 (docs/10 R-D1) |
| status | TEXT | NOT NULL DEFAULT 'active' | `active` / `degraded` / `disabled` |

保持: 永続。

#### `ingest_state` — 収集ウォーターマーク

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| stream_id | TEXT | **PK** | `{source_id}:{stream}:{instrument_id?}` 例 `binance_rest:klines_1m:BTCUSDT.BINANCE.PERP` |
| watermark_ts | INTEGER | NOT NULL | 取得済み最終事象時刻 |
| last_run_at | INTEGER | | |
| last_status | TEXT | | `ok` / `error:{code}` |
| consecutive_errors | INTEGER | NOT NULL DEFAULT 0 | 閾値超で `dq_issues` + ソース degraded |

保持: 永続 (上書き)。

#### `dq_issues` — データ品質インシデント

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| issue_id | INTEGER | **PK AUTOINCREMENT** | |
| detected_at | INTEGER | NOT NULL | |
| stream_id | TEXT | NOT NULL | |
| rule_id | TEXT | NOT NULL | docs/03 §6 の DQ-xx |
| severity | TEXT | NOT NULL | `info` / `warn` / `critical` |
| window_start, window_end | INTEGER | | 影響範囲 |
| detail | TEXT | | JSON |
| status | TEXT | NOT NULL DEFAULT 'open' | `open` / `acked` / `resolved` / `wontfix` |
| resolved_at | INTEGER | | |

Index: `(status, severity)`, `(stream_id, detected_at)`。保持: 永続。

#### `ingest_tasks` — 収集リトライキュー (**Cloudflare Queues の無料代替**, docs/01 §3.1)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| task_id | TEXT | **PK** | ULID |
| stream_id | TEXT | NOT NULL | 対象ストリーム |
| window_start, window_end | INTEGER | NOT NULL | 再取得範囲 |
| attempts | INTEGER | NOT NULL DEFAULT 0 | ≥5 で `dead` → dq_issues 起票 |
| next_attempt_at | INTEGER | NOT NULL | 指数バックオフ (5m→15m→1h→6h→24h) をこの値で表現 |
| status | TEXT | NOT NULL DEFAULT 'pending' | `pending` / `dead` / `done` |
| last_error | TEXT | | |
| created_at | INTEGER | NOT NULL | |

Index: `(status, next_attempt_at)`。保持: done/dead は 30 日で削除可 (dead は dq_issues に転記済み)。
5m tick が毎回 `status='pending' AND next_attempt_at<=now` を最大 10 件消化する (docs/01 §3.1)。

#### `latest_snapshots` — 最新値ボード (**KV スナップショットの無料代替**: KV Free は書込 1,000/日で不足)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| key | TEXT | **PK** | `funding:binance:BTCUSDT` 等 ~12 キー |
| value | TEXT | NOT NULL | JSON `{v, ts, ingested_at}` |
| updated_at | INTEGER | NOT NULL | |

UPSERT (~12 キー × 288 回/日 ≈ 3.5K 行書込/日 — D1 の書込枠 100K/日 に対し軽微)。`/market/overview` はこの表 1 read で組成。

#### `quota_usage` — 無料枠ヘッドルーム記録 (docs/13 §7)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| dt | TEXT | PK① | `YYYY-MM-DD` |
| resource | TEXT | PK② | `d1_size_bytes` / `d1_writes` / `d1_reads` / `r2_bytes` / `r2_class_a` / `worker_requests` / `subreq_peak` / `gha_minutes_month` / `kv_writes` |
| value | REAL | NOT NULL | 実測値 |
| budget | REAL | NOT NULL | その時点の予算値 (docs/13 §1) |

保持: 永続 (容量トレンド分析に使う)。60%/80% 閾値の警告ロジックは api/ingest が本表を参照。

#### `jobs` — 研究ジョブキュー

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| job_id | TEXT | **PK** | ULID |
| kind | TEXT | NOT NULL | `eep_full` / `eep_incremental` / `discovery_batch` / `regime_refit` / `archive` |
| payload | TEXT | NOT NULL | JSON (edge_version_id, snapshot_id, 等) |
| status | TEXT | NOT NULL | `queued` / `dispatched` / `running` / `done` / `failed` / `cancelled` |
| priority | INTEGER | NOT NULL DEFAULT 5 | 1 (高) – 9 |
| created_at, started_at, finished_at | INTEGER | | |
| error | TEXT | | |
| result_ref | TEXT | | R2 パス or run_id |

Index: `(status, priority, created_at)`。保持: 180 日で done/failed を R2 アーカイブ後削除可。

#### `audit_log` — 状態変更の監査

| カラム | 型 | 制約 |
|---|---|---|
| id | INTEGER | **PK AUTOINCREMENT** |
| at | INTEGER | NOT NULL |
| actor | TEXT | NOT NULL (`user:{email}` / `system:{worker}` / `ai`) |
| action | TEXT | NOT NULL (例 `edge.transition`, `settings.update`) |
| entity | TEXT | NOT NULL (`edge:{id}` 等) |
| detail | TEXT | JSON |

Index: `(entity, at)`。保持: 永続。

#### `settings` — アプリ設定 (単一ユーザ)

| カラム | 型 | 制約 |
|---|---|---|
| key | TEXT | **PK** (`cost_model.default`, `thresholds.eep`, `ui.watchlist`, ...) |
| value | TEXT | NOT NULL JSON |
| updated_at | INTEGER | NOT NULL |

---

### 2.2 市場データ系 (専用テーブル)

#### `candles` — OHLCV

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| instrument_id | TEXT | PK① | |
| tf | TEXT | PK② | `1m` / `5m` / `1h` / `1d` |
| ts | INTEGER | PK③ | 足の開始時刻 |
| open, high, low, close | REAL | NOT NULL | |
| volume | REAL | NOT NULL | base 数量 |
| quote_volume | REAL | | |
| taker_buy_volume | REAL | | CVD 計算用 (Binance) |
| trades | INTEGER | | 約定回数 |
| ingested_at | INTEGER | NOT NULL | |

**PK**: `(instrument_id, tf, ts)`。追加 Index: `(tf, ts)`。
保持 (無料枠版, docs/13 §2.1): `1m` = D1 に **30 日** (超過分は週次で R2 Parquet へ)、`5m` = **180 日**、`1h`/`1d` = 永続。
確定足のみ保存 (未確定足は `latest_snapshots` のみ)。

#### `funding_rates`

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| instrument_id | TEXT | PK① | perp のみ |
| ts | INTEGER | PK② | funding 決済時刻 |
| rate | REAL | NOT NULL | 実現 funding 率 |
| predicted_rate | REAL | | 取得時点の予測値 (別途 5m スナップは metrics へ) |
| mark_price | REAL | | |
| ingested_at | INTEGER | NOT NULL | |

**PK**: `(instrument_id, ts)`。保持: 永続 (8h × 3 取引所 ≈ 3,300 行/年で軽い)。

#### `open_interest`

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| instrument_id | TEXT | PK① | |
| ts | INTEGER | PK② | スナップ時刻 (5m 丸め) |
| oi_base | REAL | NOT NULL | BTC 建て |
| oi_usd | REAL | | |
| ingested_at | INTEGER | NOT NULL | |

**PK**: `(instrument_id, ts)`。保持: 5m 粒度 **180 日** → R2 (アーカイブ時に 1h 集約版を D1 に残す)。

#### `long_short_ratios`

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| instrument_id | TEXT | PK① | |
| ratio_type | TEXT | PK② | `global_account` / `top_account` / `top_position` / `taker_vol` |
| ts | INTEGER | PK③ | 5m 丸め |
| long_ratio | REAL | NOT NULL | 0–1 |
| short_ratio | REAL | NOT NULL | |
| ls_ratio | REAL | | long/short |
| ingested_at | INTEGER | NOT NULL | |

保持: **180 日** → R2。

#### `liquidations_5m` — 清算 (5 分バケット集計)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| instrument_id | TEXT | PK① | |
| ts | INTEGER | PK② | バケット開始 |
| long_liq_usd | REAL | NOT NULL DEFAULT 0 | ロング清算額 |
| short_liq_usd | REAL | NOT NULL DEFAULT 0 | |
| events | INTEGER | NOT NULL DEFAULT 0 | 件数 |
| max_single_usd | REAL | | 最大単発 |
| source_id | TEXT | NOT NULL | `binance_ws` / `coinglass` |
| ingested_at | INTEGER | NOT NULL | |

保持: **180 日** → R2。注意: Binance forceOrder ストリームは 2021 年以降サンプリング配信 (完全ではない)。`source_id` で系列を区別し、混ぜない (docs/03 §2.4)。

#### `orderbook_snaps` — 板スナップショット (5 分)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| instrument_id | TEXT | PK① | |
| ts | INTEGER | PK② | |
| best_bid, best_ask | REAL | NOT NULL | |
| spread_bps | REAL | NOT NULL | |
| bid_depth_1pct, ask_depth_1pct | REAL | | ±1% 内 USD 深さ |
| imbalance | REAL | | (bid−ask)/(bid+ask) depth |
| ingested_at | INTEGER | NOT NULL | |

保持: **90 日** → R2。V1 はスナップのみ (L2 録画は V3, docs/01 §7)。

#### `options_surface` — オプション集計 (Deribit)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| underlying | TEXT | PK① | `BTC` |
| ts | INTEGER | PK② | 1h 丸め |
| dvol | REAL | | Deribit DVOL |
| rv_30d | REAL | | 実現ボラ (research が逆流し込み) |
| vrp | REAL | | dvol − rv_30d |
| rr25_1m | REAL | | 25Δ リスクリバーサル (1M) |
| fly25_1m | REAL | | 25Δ バタフライ |
| atm_iv_1m | REAL | | |
| total_oi_calls, total_oi_puts | REAL | | |
| max_pain | REAL | | 直近限月 |
| gex_proxy | REAL | | ディーラーガンマ推定 (符号付き, V2) |
| ingested_at | INTEGER | NOT NULL | |

保持: 永続 (1h × 1 underlying は軽量)。

---

### 2.3 汎用メトリクス系

#### `metric_defs` — メトリクスレジストリ

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| metric_id | TEXT | **PK** | 命名規約 `{domain}.{name}[.{venue}]` 例 `onchain.exchange_netflow_btc`, `flow.etf_net_usd`, `sent.fear_greed`, `deriv.coinbase_premium_bps` |
| domain | TEXT | NOT NULL | `onchain` / `macro` / `flow` / `sent` / `deriv` / `dex` / `mining` |
| name | TEXT | NOT NULL | |
| unit | TEXT | NOT NULL | `usd` / `btc` / `bps` / `ratio` / `index` / `count` |
| cadence | TEXT | NOT NULL | `5m` / `1h` / `1d` / `1w` |
| source_id | TEXT | NOT NULL FK | |
| pit_lag_ms | INTEGER | NOT NULL DEFAULT 0 | 公表遅延 (例: ETF フローは T+1 09:00ET)。バックテストで ts+pit_lag 以降のみ参照可 |
| revisable | INTEGER | NOT NULL DEFAULT 0 | 改訂されうるか (1 なら as-of 参照必須) |
| retention_days | INTEGER | | NULL=永続 |
| description | TEXT | | |

保持: 永続。初期登録リストは docs/03 §3。

#### `metrics` — 汎用時系列 (long format, 二時制)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| metric_id | TEXT | PK① FK | |
| ts | INTEGER | PK② | 事象時刻 (日次は UTC 00:00) |
| ingested_at | INTEGER | PK③ | 取得時刻。改訂のたびに新行 |
| value | REAL | NOT NULL | |
| meta | TEXT | | JSON (内訳等) |

**PK**: `(metric_id, ts, ingested_at)`。追加 Index: `(metric_id, ingested_at)`。
最新値ビュー相当のクエリ: `MAX(ingested_at) GROUP BY metric_id, ts` (api 層でヘルパー化)。
保持: `metric_defs.retention_days` に従い週次アーカイブ。日次系は永続。

---

### 2.4 イベント系

#### `events` — 離散イベント (カレンダー + 検知)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| event_id | TEXT | **PK** | ULID |
| event_type | TEXT | NOT NULL | `fomc` / `cpi` / `nfp` / `option_expiry` / `cme_gap` / `usdt_mint` / `usdt_burn` / `whale_transfer` / `liq_cascade` / `etf_flow_extreme` / `halving` / `custom` |
| ts | INTEGER | NOT NULL | 事象時刻 (予定イベントは予定時刻) |
| announced_at | INTEGER | | 判明時刻 (PIT 用) |
| magnitude | REAL | | 正規化強度 (z-score 等、型はイベント別) |
| payload | TEXT | | JSON (例 usdt_mint: {amount_usd, chain, tx}) |
| source_id | TEXT | NOT NULL | |
| dedupe_key | TEXT | **UNIQUE** | `{event_type}:{ts丸め}:{識別子}` 重複投入防止 |

Index: `(event_type, ts)`。保持: 永続。イベントスタディ (docs/05 §3.2) の入力。

---

### 2.5 研究系 (Edge レジストリ)

#### `edges` — Edge 台帳

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| edge_id | TEXT | **PK** | ULID |
| slug | TEXT | **UNIQUE** NOT NULL | `cme-gap-fill` 等 |
| title | TEXT | NOT NULL | |
| category | TEXT | NOT NULL | PDF 踏襲: `microstructure` / `liquidation` / `options` / `seasonality` / `etf_flow` / `onchain` / `stablecoin` / `cross_asset` / `behavioral` / `event` / `vol_regime` / `cross_venue` |
| status | TEXT | NOT NULL | 状態機械 (docs/05 §2): `IDEA` / `CANDIDATE` / `TESTING` / `VALIDATED` / `PAPER` / `ACTIVE` / `DECAYING` / `RETIRED` / `REJECTED` |
| hypothesis | TEXT | NOT NULL | 仮説 (何がなぜ起きるか) |
| rationale | TEXT | NOT NULL | 経済的根拠 (誰がなぜ負ける側に立つか) |
| counter_evidence | TEXT | | 反証・注意点 (必須運用: TESTING 遷移までに記入) |
| evidence | TEXT | | JSON 配列 [{kind: paper/blog/internal, ref, note}] |
| origin | TEXT | NOT NULL | `pdf_seed` / `discovery` / `ai_hypothesis` / `manual` |
| pdf_ref | TEXT | | 例 `EC-021` (PDF 由来のみ) |
| priors | TEXT | | JSON。PDF の星評価等の主観事前評価 {originality:3, capacity:5, ...} |
| discovery_finding_id | TEXT | | FK → discovery_findings (由来がある場合) |
| created_at, updated_at | INTEGER | NOT NULL | |

Index: `(status)`, `(category, status)`。保持: 永続・削除禁止。

#### `edge_versions` — Edge 定義の不変バージョン

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| version_id | TEXT | **PK** | ULID |
| edge_id | TEXT | NOT NULL FK | |
| semver | TEXT | NOT NULL | `1.0.0`。**UNIQUE** `(edge_id, semver)` |
| signal_spec | TEXT | NOT NULL | JSON。シグナル定義 DSL (docs/05 §9)。作成後不変 |
| params | TEXT | NOT NULL | JSON。閾値等。作成後不変 |
| instrument_id | TEXT | NOT NULL FK | 対象銘柄 |
| direction | TEXT | NOT NULL | `long` / `short` / `both` / `vol` |
| horizon | TEXT | NOT NULL | 保有期間表現 `5m`–`30d` or `event+72h` |
| entry_universe | TEXT | | JSON。条件付け (レジーム制約等) |
| cost_model | TEXT | NOT NULL | JSON {taker_bps, slippage_bps, funding_included} |
| changelog | TEXT | | 前バージョンからの変更理由 |
| created_at | INTEGER | NOT NULL | |
| is_current | INTEGER | NOT NULL DEFAULT 1 | 最新フラグ (edge_id 内で 1 つ) |

**不変性**: UPDATE 禁止 (is_current の付替えのみ許可)。パラメータ変更 = 新バージョン。これが Version 管理の中核。
Index: `(edge_id, is_current)`。保持: 永続。

#### `edge_transitions` — 状態遷移履歴

| カラム | 型 | 制約 |
|---|---|---|
| id | INTEGER | **PK AUTOINCREMENT** |
| edge_id | TEXT | NOT NULL FK |
| from_status, to_status | TEXT | NOT NULL |
| at | INTEGER | NOT NULL |
| actor | TEXT | NOT NULL |
| reason | TEXT | NOT NULL (遷移根拠。run_id 参照可) |
| run_id | TEXT | FK (判定根拠の Run) |

Index: `(edge_id, at)`。保持: 永続。

#### `eval_runs` — 評価実行 (= Trial Registry)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| run_id | TEXT | **PK** | ULID |
| edge_version_id | TEXT | NOT NULL FK | |
| protocol_version | TEXT | NOT NULL | EEP のバージョン (docs/05 §1) |
| run_kind | TEXT | NOT NULL | `screen` / `full` / `incremental` / `decay_check` |
| dataset_hash | TEXT | NOT NULL | R2 snapshot manifest の sha256 |
| snapshot_id | TEXT | NOT NULL | |
| seed | INTEGER | NOT NULL | 乱数シード |
| config | TEXT | NOT NULL | JSON (WF 分割数, permutation 回数, コスト等の全設定) |
| status | TEXT | NOT NULL | `running` / `done` / `failed` |
| started_at, finished_at | INTEGER | | |
| artifact_ref | TEXT | | R2 `artifacts/runs/{run_id}/` |
| requested_by | TEXT | NOT NULL | actor |
| git_sha | TEXT | NOT NULL | research コードのコミット (再現性) |

**多重検定補正の基盤**: 同一 edge_id への `screen`/`full` の累積回数が試行数 N として Deflated Sharpe / FDR 計算に使われる (docs/05 §4)。だから **失敗 Run も削除しない**。
Index: `(edge_version_id, finished_at)`, `(run_kind, finished_at)`。保持: 永続。

#### `eval_metrics` — 評価メトリクス (long format)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| run_id | TEXT | PK① FK | |
| segment | TEXT | PK② | `overall` / `wf:oos` / `wf:fold{n}` / `regime:{label}` / `year:{yyyy}` / `cost:zero` |
| metric | TEXT | PK③ | `sharpe`, `sortino`, `calmar`, `pf`, `win_rate`, `ev_bps`, `max_dd`, `trades`, `n_eff`, `p_perm`, `dsr`, `psr`, `auc`, `precision`, `recall`, `f1`, `ir`, `turnover`, `capacity_usd`, ... (docs/05 §5 の全定義) |
| value | REAL | NOT NULL | |
| ci_lo, ci_hi | REAL | | Bootstrap/Wilson 95% CI |
| meta | TEXT | | JSON |

**PK**: `(run_id, segment, metric)`。保持: 永続。

#### `verdicts` — 判定

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| run_id | TEXT | **PK** FK | full run のみ |
| verdict | TEXT | NOT NULL | `ADOPT` / `WATCH` / `REJECT` |
| score | REAL | | 総合スコア 0–100 (docs/05 §6) |
| reasons | TEXT | NOT NULL | JSON 配列 [{check, pass, value, threshold}] |
| thresholds_version | TEXT | NOT NULL | settings の閾値セットのバージョン |
| decided_at | INTEGER | NOT NULL | |

保持: 永続。

#### `edge_correlations` — Edge 間相関 (docs/05 §8)

| カラム | 型 | 制約 |
|---|---|---|
| edge_a, edge_b | TEXT | **PK①②** (edge_a < edge_b) |
| window | TEXT | **PK③** (`1y` / `all`) |
| signal_overlap | REAL | シグナル発火の Jaccard 係数 |
| return_corr | REAL | 日次リターン相関 |
| computed_at | INTEGER | NOT NULL |
| run_batch | TEXT | |

保持: 上書き更新 + 月次スナップを R2。

#### `regimes_daily` — レジームラベル (docs/04 §6)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| dt | TEXT | **PK** | `YYYY-MM-DD` |
| trend | TEXT | NOT NULL | `up` / `down` / `range` |
| vol | TEXT | NOT NULL | `low` / `high` / `extreme` |
| liquidity | TEXT | NOT NULL | `normal` / `stressed` |
| hmm_state | INTEGER | | HMM 状態番号 |
| probs | TEXT | | JSON (状態確率ベクトル) |
| model_version | TEXT | NOT NULL | models/ の参照 |
| computed_at | INTEGER | NOT NULL | |

保持: 永続。再計算時は上書きだが `model_version` で系譜管理。過去ラベルの再計算は look-ahead を生むため、**バックテストには「computed_at 時点で存在したラベル」ではなく「因果的に計算可能なラベル」だけを使う** (docs/04 §6.3)。

#### `feature_defs` — 特徴量レジストリ (実体は R2 Parquet)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| feature_id | TEXT | **PK** | `funding_z_30d` 等 |
| version | INTEGER | NOT NULL | 定義変更でインクリメント |
| spec | TEXT | NOT NULL | JSON (入力 metric/テーブル, 変換, 窓, ラグ) |
| cadence | TEXT | NOT NULL | |
| lookback_required | TEXT | | 必要履歴 |
| family | TEXT | NOT NULL | docs/04 §3 の分類 |
| status | TEXT | NOT NULL DEFAULT 'active' | |
| created_at | INTEGER | NOT NULL | |

保持: 永続。

#### `discovery_findings` — Discovery スクリーニング結果 (docs/04 §5)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| finding_id | TEXT | **PK** | ULID |
| batch_id | TEXT | NOT NULL | 実行バッチ (= run of discovery) |
| kind | TEXT | NOT NULL | `conditional_return` / `event_study` / `interaction` / `ml_importance` / `anomaly` / `changepoint` |
| spec | TEXT | NOT NULL | JSON (feature, condition, horizon) |
| stats | TEXT | NOT NULL | JSON (n, mean_ret_bps, t, p_raw, ...) |
| fdr_q | REAL | NOT NULL | バッチ内 BH 補正後 q 値 |
| novelty | REAL | | 既存 Edge との重複度 (低いほど新規) |
| status | TEXT | NOT NULL DEFAULT 'new' | `new` / `promoted` / `dismissed` / `duplicate` |
| promoted_edge_id | TEXT | | FK |
| created_at | INTEGER | NOT NULL | |

Index: `(batch_id)`, `(status, fdr_q)`。保持: 永続。

#### `paper_signals` — ペーパートレード記録 (docs/05 §9)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| signal_id | TEXT | **PK** | ULID |
| edge_version_id | TEXT | NOT NULL FK | |
| status | TEXT | NOT NULL | `open` / `closed` / `expired` / `invalidated` |
| direction | TEXT | NOT NULL | `long` / `short` |
| ts_signal | INTEGER | NOT NULL | シグナル発火時刻 |
| ts_entry, ts_exit | INTEGER | | エントリは発火の**次バー始値** (look-ahead 防止) |
| entry_px, exit_px | REAL | | |
| ret_bps | REAL | | コスト前 |
| ret_net_bps | REAL | | コスト後 |
| trigger_snapshot | TEXT | NOT NULL | JSON。発火時の入力値一式 (事後検証用) |

Index: `(edge_version_id, ts_signal)`, `(status)`。保持: 永続。

#### `ai_outputs` — AI 生成物 (docs/07)

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| output_id | TEXT | **PK** | ULID |
| kind | TEXT | NOT NULL | `briefing` / `dossier_draft` / `hypothesis` / `dq_summary` / `improvement` |
| ref_date | TEXT | | 対象日 |
| entity | TEXT | | 対象 (`edge:{id}` 等) |
| model | TEXT | NOT NULL | 使用モデル ID |
| prompt_version | TEXT | NOT NULL | プロンプトテンプレのバージョン |
| content_ref | TEXT | NOT NULL | R2 パス (本文は R2、D1 には持たない) |
| tokens_in, tokens_out | INTEGER | | コスト監視 |
| status | TEXT | NOT NULL DEFAULT 'draft' | `draft` / `reviewed` / `archived` |
| created_at | INTEGER | NOT NULL | |

Index: `(kind, ref_date)`。保持: 永続 (本文 R2)。

---

## 3. ER 概要

```
instruments ─┬─< candles / funding_rates / open_interest / long_short_ratios
             ├─< liquidations_5m / orderbook_snaps
             └─< edge_versions >── edges ──< edge_transitions
metric_defs ──< metrics                └──< edge_correlations (自己結合)
data_sources ─< metric_defs / ingest_state / events
edges ──< edge_versions ──< eval_runs ──< eval_metrics
                     │            └── verdicts (1:1)
                     └──< paper_signals
discovery_findings >── edges (promoted)
feature_defs (R2 features の台帳) / regimes_daily / events (独立参照系)
jobs / dq_issues / audit_log / settings / ai_outputs (運用系)
```

## 4. 容量試算 (V1, BTC 中心 + ETH) — **D1 Free 5GB 前提**

詳細な予算は docs/13 §2 が正典。要約: 定常 ~0.7 GB + 研究系 ~0.1 GB/年 → **5 年運用でも 5 GB の 40% 未満**。
書込み予算: 定常 ~15K 行/日 (Free 上限 100K 行/日 の 15%)。読取りは Actions が R2 Parquet を読む設計により UI/internal のみで <100K 行/日。
D1 使用率 50% (2.5GB) 到達で Telegram 警告 → 保持期間短縮 or Workers Paid 化判断 (docs/13 §6)。

## 5. 保持期間・アーカイブ (週次 `archive` ジョブ)

| データ | D1 保持 (無料枠版) | その後 |
|---|---|---|
| candles 1m | **30 日** | R2 `curated/market/candles_1m/` Parquet (永続) |
| 5m 粒度系 (OI, LS, liq, metrics 5m) | **180 日** (orderbook **90 日**) | R2 Parquet (永続) |
| 1h/1d 系, funding, options_surface, events | 永続 (D1) | 月次で R2 にもミラー (バックアップ兼研究入力) |
| raw NDJSON (R2, 無圧縮 — Worker CPU 10ms 制約で gzip しない) | — | **90 日で Parquet 化検証後に削除** (weekly Actions) |
| 研究系テーブル | 永続 | 月次 R2 ミラー (バックアップ) |
| ingest_tasks (done/dead) | 30 日 | 削除 (dead は dq_issues に転記済み) |

アーカイブジョブの完全性検査: 行数 + min/max ts + チェックサムを manifest 化し、一致確認後に D1 から DELETE (docs/12 §3)。

## 6. バージョン管理の全体像

| 対象 | 機構 |
|---|---|
| Edge 定義 | `edge_versions` (不変, semver)。変更 = 新バージョン + changelog |
| 評価プロトコル | `protocol_version` 定数 (research パッケージのリリースと連動) |
| 判定閾値 | `settings['thresholds.eep']` に version 付き JSON。verdicts が参照バージョンを記録 |
| 特徴量 | `feature_defs.version` + R2 features/{feature_set_version}/ |
| データセット | R2 snapshot manifest の sha256 (`eval_runs.dataset_hash`) |
| レジームモデル | `regimes_daily.model_version` + R2 models/ |
| AI プロンプト | `ai_outputs.prompt_version` |
| コード | `eval_runs.git_sha` |

この 8 点が揃うことで docs/00 §3-1 の再現性原則が満たされる。
