# 14. Edge Pack v1 実装計画書

> **性質**: これは設計文書であり、コード実装はしない。実装は別セッション (Sonnet) へ引き継ぐ前提で、signal_spec・依存関係・実装順序・期待値のみを確定する。
> **目的**: PDF 由来 54 Edge のうち signal_spec が一度も書かれていない 50 件を、「順番に検証可能な状態へ持っていく最初の土台」として、評価可能性で分類し、最初の 12-14 件を実際に評価まで持っていく設計を確定する。
> **前提の確認方法**: docs/00-13 全文、`research/src/cryptoedge_research/{dsl,eval,features,jobs}/*.py`、`apps/api/src/{routes,services}/*.ts`、D1 本番データ (edges/edge_versions/eval_runs) を実地に参照して作成 (2026-07 design audit 継続)。

---

## 1. 現状確認 (この計画の前提)

### 1.1 D1 の実態 (2026-07-04 時点)

| 項目 | 件数 |
|---|---|
| `edges` 総数 | 54 |
| `edge_versions` (signal_spec) が存在する edge | **4** (docs/09 §3 の P0 5 件のうち 4 件 — vrp-monitor は docs/09 が明示的に「V1 は観測のみ、IDEA 維持」としているため意図通り未実装) |
| そのうち `eval_runs` 実行済み | 2 |
| signal_spec が一度もないedge | **50** |

→ 監査ロードマップが「~50件の未評価Edge」と記していたのは不正確で、実態は「50件が"評価待ち"ではなく"signal_spec 未作成"」。TASK-5 (screen/full 差別化) は完了済みだが、それだけでは50件は1件も動かない。**Edge Pack v1 の本質は "評価" ではなく "DSL 翻訳"** である。

### 1.2 現在使える構成要素 (これ以外は使えない)

**Feature Store v1 (`research/src/cryptoedge_research/features/registry.py`, 1h cadence, BTCUSDT.BINANCE.PERP / ETHUSDT.BINANCE.PERP のみ deriv 系あり)**

| family | feature_id | 意味 |
|---|---|---|
| price | `ret_24h` | 24h 変化率 (%) |
| price | `rv_24h` | 24h 実現ボラ (log return std) |
| price | `rv_30d_pctile_1y` | 30d実現ボラの1yパーセンタイル |
| price | `atr_14d` | 14d ATR |
| price | `sma200_dist_pct` | SMA200 乖離率 |
| price | `high_24h_dist` | 24h高値からの乖離率 |
| price | `taker_buy_ratio_24h` | 24h テイカー買い比率 |
| price | `vol_ma_ratio_7_30` | 出来高 MA7/MA30 比 |
| deriv | `funding_z_30d` | funding rate 30d z-score |
| deriv | `funding_chg_24h` | funding rate 24h 差分 |
| deriv | `oi_chg_24h` | OI 24h変化率 |
| deriv | `oi_pctile_1y` | OI 1yパーセンタイル |
| deriv | `ls_all_account_z_30d` | 全アカウント L/S 比 z-score |
| deriv | `ls_top_trader_z_30d` | 上位トレーダー L/S 比 z-score |
| deriv | `liq_notional_24h` | 24h 清算想定元本合計 |

**events (`workers/ingest/src/adapters/{yahoo-finance,etherscan,econ-calendar}.ts`)**: `cme_gap`, `usdt_mint` が稼働中。`econ_calendar` (fomc/cpi_release/nfp_release/ppi_release) は投入機構のみ実装済みで **`ECON_CALENDAR` 配列は意図的に空** (TASK-4: 検証できない日付を捏造しない方針)。

**regime (`regimes_daily`)**: trend (up/down/range) × vol (low/high/extreme) × liquidity (normal/stressed)、ルールベース、日次。

**DSL (`packages/schema` の BoolExpr, Python/TS 両実装)**: `and`/`or`/`not`/`cmp`/`event`/`regime`/`time` の7ノードのみ。`time` は `utc_hour_in` (時刻の配列) と `dow_in` (曜日, Sun=0..Sat=6) のみサポート — **day-of-month 条件は存在しない**。

**EEP (`eval/pipeline.py`)**: `SCREEN_EEP_CONFIG` (permutation 200/bootstrap 300/fold 3, TASK-5 で実装) と `FULL_EEP_CONFIG` (1000/2000/5) の2段。

**Edge ライフサイクル状態機械 (`apps/api/src/services/edge-lifecycle.ts`)**: IDEA→CANDIDATE→TESTING→VALIDATED→PAPER→ACTIVE の全ゲートは**実装済み・確認済み** (2026-07-04 TASK-5 調査時に確認)。

### 1.3 発見した未解決ギャップ (この計画に影響するもの)

- **`paper_signals` に書き込み処理が存在しない** (`nightly.py` のdocstringに言及があるのみで実装なし)。VALIDATED→PAPER 遷移自体は可能だが、PAPER 状態のEdgeについて誰も `paper_signals` へシグナルを記録しないため、**PAPER→ACTIVE ゲートは現状絶対に満たせない**。監査ロードマップの TASK-6 (paper trading配線, W8-9, 未着手) がこの計画の暗黙の前提として必須であることを明記する (§6)。
- `cost_model.funding_included` フィールドは `edge_versions.cost_model` JSON に存在するが、`research/.../eval/backtest.py` の `CostModel` dataclass は `taker_bps`/`slippage_bps` しか持たず、**funding コストは一切バックテストに反映されない**。funding 保有系Edge (funding-rate-mean-reversion 等) の counter_evidence に明記する。
- `options_surface.dvol` は Deribit アダプタで収集されているが、Feature Store (registry.py) に未統合。VRP 系Edgeを評価可能にするための最小追加。

---

## 2. 50 Edge 全件分類 (A/B/C/D)

判定基準:
- **A = 今すぐ評価可能**: §1.2 の構成要素だけで signal_spec が書ける
- **B = 小さな追加だけで評価可能**: 新規データソースは不要。既存の演算子/adapter/DSLノードの小さな拡張、または `econ_calendar`/`options_surface` のような**既存の空/未統合の入れ物を埋める**だけで済む
- **C = 新しいデータソースが必要**: 新しい adapter・外部API・テーブルが必要 (docs/03 の V2/V3 相当)
- **D = Discovery Engine完成後**: 単一の固定ルールでは仮説を適切に検証できず、条件付け探索/交互作用/MLによる非線形検証 (docs/04 §5 Stage3-5) が本質的に必要

| # | slug | category | 分類 | 理由 |
|---|---|---|---|---|
| 1 | price-momentum-continuation | behavioral | **A** | `ret_24h` のみで表現可 |
| 2 | google-trends-overheat-fomo-fade | behavioral | C | Google Trends 未実装 |
| 3 | round-number-price-clustering | behavioral | **B** | 新規op `round_number_dist` が必要 (close only, 新規データ源不要) |
| 4 | dxy-correlation-regime | cross_asset | C | DXY (FRED) 未実装 |
| 5 | global-m2-liquidity-linkage | cross_asset | C | M2 (FRED) 未実装 |
| 6 | nasdaq-cross-asset-regime-linkage | cross_asset | C | Nasdaq (yahoo) 未実装 |
| 7 | cross-exchange-funding-divergence | cross_venue | C | Bybit/Hyperliquid funding 未実装 (OKX単独のみ) |
| 8 | eth-cross-sectional-feature-transfer-from-btc | cross_venue | **D** | 「特徴量が銘柄を超えて転移するか」自体が Discovery Engine の検証対象 |
| 9 | hyperliquid-on-chain-positioning-transparency | cross_venue | C | Hyperliquid API 未実装 |
| 10 | kimchi-premium-korea-exchange-spread | cross_venue | C | Upbit 未実装 |
| 11 | perp-spot-volume-ratio-leverage-regime | cross_venue | C | 現物出来高との比較に必要な別 instrument 系列の設計が必要 (単純な追加ではない) |
| 12 | regional-cex-flow-divergence-coinbase-vs-binance | cross_venue | C | Coinbase出来高データ未実装 |
| 13 | cme-cot-positioning-reversal | etf_flow | C | CFTC COT 未実装 |
| 14 | coinbase-premium-as-an-etf-flow-proxy | etf_flow | C | Coinbase価格データ未実装 |
| 15 | etf-flow-sentiment-divergence | etf_flow | C | ETF フロー未実装 (F&G は実装済みだが片側のみでは不可) |
| 16 | etf-t-1-sell-pressure | etf_flow | C | ETF フロー未実装 |
| 17 | altcoin-sideways-breakout-drift-btc-pair | event | C | 複数instrument比較 (ETH/BTC比) は現行DSL/EEPが単一instrument前提のため設計変更が必要 |
| 18 | cpi-macro-print-volatility-compression | event | **B** | `econ_calendar` (cpi_release/ppi_release) にデータ投入するだけ |
| 19 | pre-fomc-drift | event | **B** | `econ_calendar` (fomc) にデータ投入するだけ |
| 20 | sell-the-news-fomc-drift | event | **B** | 同上 |
| 21 | funding-rate-mean-reversion | liquidation | **A** | `funding_z_30d` のみ |
| 22 | funding-settlement-microstructure-pattern | liquidation | **A** | `time.utc_hour_in` のみ |
| 23 | liquidation-heatmap-magnet | liquidation | C | 価格帯別の清算密集度 (現状は集計済み想定元本合計のみ、価格帯粒度データなし) |
| 24 | open-interest-price-divergence | liquidation | **A** | `ret_24h` + `oi_chg_24h` |
| 25 | three-exchange-basis-convergence | liquidation | C | Binance/OKX/Deribit間ベーシス比較データ未実装 |
| 26 | top-trader-long-short-ratio-extremes | liquidation | **A** | `ls_top_trader_z_30d` のみ |
| 27 | cross-exchange-ofi-lead-lag-coinbase-binance | microstructure | C | L2板データ未実装 (docs/03 V3 相当) |
| 28 | cvd-price-divergence | microstructure | C | CVD (累積出来高デルタ) 未実装 |
| 29 | order-book-depth-regression-on-spread-returns | microstructure | C | 板厚みデータ未実装 |
| 30 | order-flow-imbalance-ofi-mid-price-prediction | microstructure | C | OFI未実装、秒足粒度も不足 |
| 31 | vpin-based-jump-prediction | microstructure | C | VPIN未実装 |
| 32 | exchange-netflow-signal | onchain | C | オンチェーンnetflow未実装 |
| 33 | exchange-whale-ratio | onchain | C | 同上 |
| 34 | whale-alert-transfer-reaction | onchain | C | Whale Alert未実装 |
| 35 | 25-delta-risk-reversal-selling | options | C | `options_surface.rr25_1m` 未収集 (Deribitアダプタはdvolのみ書込み) |
| 36 | 25-delta-skew-as-a-realized-vol-forecaster | options | C | 同上 |
| 37 | dealer-gamma-exposure-gex-regime | options | **D** | GEXデータが仮に揃っても「レジーム自体が予測力を持つか」は交互作用検証が本質、単純な閾値ルールでは仮説を適切に代表できない |
| 38 | options-expiry-sq-max-pain-gravitational-pull | options | C | `max_pain` 未収集 + 限月カレンダー未実装 |
| 39 | variance-risk-premium-vrp-selling | options | **B** | `options_surface.dvol` は収集済み。Feature Store への統合 (`vrp = dvol - rv_30d`) のみで評価可能。**注: docs/09 §3 はこの Edge (EC-013) を「V1は観測のみ、戦略化はV2判断」と明記** — Phase 4 で評価可能にするのは元ロードマップからの意図的な前倒し (§4.3 で承認確認) |
| 40 | monday-asia-open-effect | seasonality | **A** | `time.dow_in`+`utc_hour_in` のみ |
| 41 | month-end-rebalance-flow | seasonality | **B** | DSL `time` ノードに day-of-month 条件が存在しない。Python/TS 両評価器 + golden vector の追加が必要 (schema変更を伴うため B の中で最も影響範囲が広い) |
| 42 | nyse-open-day-of-week-effect | seasonality | **A-** (簡易版) | `time.dow_in`+`utc_hour_in` で近似可能。ただし原仮説は「日中/夜間セッション分解 × 曜日」の全曜日比較であり、単一ルールでは仮説の一部しか検証できない。**Discovery Engine Stage 1 (曜日×時間の全数走査) の方が正しい検証形態** — 詳細は当該Edgeの節で明記 |
| 43 | weekly-breakout-continuation | seasonality | **B** | 既存 op `rolling_high_dist` を window=168 (7d) で使う新規 FeatureDef 1行を追加するだけ (新規演算子は不要) |
| 44 | stablecoin-issuance-acceleration | stablecoin | C | ステーブルコイン供給データ未実装 |
| 45 | stablecoin-supply-ratio-ssr-low-reversal | stablecoin | C | 同上 |
| 46 | usdt-depeg-risk-off-signal | stablecoin | C | USDT/USDCペアのデペッグ検知データ未実装 |
| 47 | garch-volatility-regime-clustering | vol_regime | **D** | GARCHモデル適合という新しい統計手法そのものが必要、単純な閾値ルールでは代替できない |
| 48 | inverted-leverage-effect-btc-vol-asymmetry | vol_regime | **D** | 非対称ボラティリティ反応の回帰分析が本質、DSL閾値ルールでは検証不能 |
| 49 | jump-dynamics-via-lee-mykland-detection | vol_regime | **D** | Lee-Myklandジャンプ検定 (新規統計手法) + OFI (未実装) の交互作用が本質 |
| 50 | session-open-close-volatility-seasonality | vol_regime | C | 5分足粒度が必要 (Feature Store は1h cadenceのみ) |

**集計**: A = 7、B = 7、C = 31、D = 5 (合計50)

---

## 3. Phase ロードマップ (提案) と元ロードマップとの整合性

### 3.1 提案する順序

ユーザー提示の例 (`Phase1 Seasonality → Phase2 Funding → Phase3 OI → Phase4 Liquidation → Phase5 Event`) は **PDFのカテゴリラベル順**だが、実際の技術的従属関係とは一致しない (例: DB上の `liquidation` カテゴリには funding/OI 系のEdgeが混在しており、真の清算ヒートマップ系Edge (`liquidation-heatmap-magnet`) はカテゴリ名に反してこの計画では評価不可)。そこで本計画は**依存関係の重さ (追加実装コスト) 順**に並べ替える。

| Phase | 内容 | 新規実装コスト | 対象Edge数 |
|---|---|---|---|
| **Phase 1** | 追加実装ゼロ (既存 Feature Store + regime + time のみ) | ゼロ | 7 (A全件) |
| **Phase 2** | 既存演算子の新規 FeatureDef 追加のみ (新規 op 不要) | 極小 (registry.py に数行) | 2 (weekly-breakout, round-number*) |
| **Phase 3** | `econ_calendar` へ公式日付を投入 (コードはゼロ、データ投入のみ) | 極小 (運用者によるFOMC/CPI/PPI日付確認) | 3 (fomc×2, cpi-vol-compression) |
| **Phase 4** | `options_surface` → Feature Store 統合 (TASK-3と同型の作業) | 小 (features_sync.py 拡張) | 1 (vrp-selling) — **docs/09の意図的先送りを前倒しする決定が必要** |
| **Phase 5** | DSL `time` ノードへ day-of-month 追加 (schema + 2言語評価器 + golden vector) | 中 (3パッケージ横断) | 1 (month-end-rebalance) |

\* round-number-price-clusteringはPhase2に含めるが、仮説自体が「有意なパターンなし」を予測する検証(falsification)目的のため優先度は最下位。

### 3.2 元ロードマップ (docs/09) との差分

- **docs/09 §2 Phase 3, §6 P1/P2** は「シード消化」を P1/P2 の一項目として抽象的に触れるのみで、50件の評価順序を具体的に定めていない。したがって本計画は**docs/09の空白を埋める新規サブ計画**であり、既存の優先順位 (P0が最優先、Discovery Engineは§6のP2) と矛盾しない。
- **唯一の逸脱点は Phase 4 (VRP)**。docs/09 §3 は vrp-monitor (EC-013) を「V1は観測のみ、戦略化はV2判断」と明記しており、これを Edge Pack v1 (実質V1後期) で評価可能にすることは元ロードマップの時期区分を前倒しする決定になる。
  - **なぜ前倒しが妥当か**: 必要なデータ (`options_surface.dvol`) は既に収集済みで、Feature Store への統合はTASK-3で確立した手順の反復に過ぎず、新規データソース契約や新規adapterは一切不要。「V2判断」という留保は「有料データが必要になるかもしれない」という当時の不確実性に基づくものであり、無料の deribit_rest だけで完結する現状では該当しない。
  - **メリット**: 追加コストゼロで、実務上最も再現性の高い暗号資産ボラティリティプレミアムの1つ (VRP) を早期に検証できる。
  - **デメリット**: 元ロードマップの版数管理 (docs/09) と実態がずれるため、本計画の採用時に **docs/09 §3 の該当行を「V1後期(Edge Pack v1 Phase4)で評価開始」に更新する** ドキュメント修正が必要になる (今回はコード変更をしないため、この修正も次セッションでのタスクとして明記)。
- Phase 5 (day-of-month) は `packages/schema` の BoolExpr 型と両言語評価器を触るため、他のPhaseと異なり**単なるFeature Store拡張ではなくプロトコル変更**である。docs/11 §4 (契約テスト) の golden vector 更新が必須になる点を明記し、他Phaseと同列に扱わないよう最後に配置した。

---

## 4. Phase 1-5 各 Edge の signal_spec 設計 (14件)

以下、すべて `instrument_id = "BTCUSDT.BINANCE.PERP"` (既存4件と同じ、deriv系特徴量が存在する唯一の系列)。`cost_model` は既存4件と同一の `{"taker_bps":4,"slippage_bps":2,"funding_included":false}` を踏襲 (§1.3 の注意点あり)。`entry.delay_bars=1, entry.price="open"` も既存規約通り。

### Phase 1 (追加実装ゼロ、7件)

#### 4.1 funding-settlement-microstructure-pattern (最優先: 最も安価かつ高い偽陽性耐性を持つ falsification test)
```json
{
  "when": {"time": {"utc_hour_in": [23, 7, 15]}},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "1h"},
  "direction": "long"
}
```
- 使用feature: なし / 使用event: なし / 必要regime: なし
- 評価期間: 全1h候補データ (2019-〜)
- 方向は仮説上未確定 (機械的フローの向きは事前予測不可) — long版をまず流し、REJECTでもWATCHでも「有意な方向性ドリフトなし」という結果自体が想定内。
- 期待Sharpe: ~0.0 (round_trip_bps=12のコストを超える1h保有の微細構造効果は稀)。期待DSR: 低 (n_trials=1でも)。期待p_perm: 高め (>0.3)、つまり**REJECT想定の確認的テスト**。

#### 4.2 monday-asia-open-effect
```json
{
  "when": {"and": [{"time": {"dow_in": [1]}}, {"time": {"utc_hour_in": [19, 20]}}]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "4h"},
  "direction": "long"
}
```
- 使用feature/event: なし / 評価期間: 全期間
- 期待Sharpe: 0.0-0.2 (曜日効果は既知になった時点で裁定されがちなためlow-confidence)。期待DSR: 低。期待p_perm: 中〜高。

#### 4.3 nyse-open-day-of-week-effect (簡易版・月曜のみ)
```json
{
  "when": {"and": [{"time": {"dow_in": [1]}}, {"time": {"utc_hour_in": [14]}}]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "2h"},
  "direction": "long"
}
```
- **重要な限定**: 原仮説 (日中/夜間セッション分解 × 全曜日比較) の一部 (月曜のみ) を検証する簡易版。全曜日を網羅する検証は Discovery Engine Stage 1 (docs/04 §5) の条件付け走査で行うのが正しい形態であり、このPhase 1版は「まず動くものを作る」ための暫定処置と明記する。
- 期待Sharpe: 0.0-0.2、期待DSR: 低、期待p_perm: 中〜高。

#### 4.4 price-momentum-continuation
```json
{
  "when": {"cmp": [{"feature": "ret_24h"}, ">", 5]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "24h"},
  "direction": "long"
}
```
- 使用feature: `ret_24h` / 評価期間: 全期間 (ret_24hの24bar lookback以降)
- 閾値5%はBTC 1hスケールでの「大幅上昇」の目安であり、Phase後続でパーセンタイル化 (`z`/`pctile`変換) して再テストする価値がある。
- 期待Sharpe: 0.2-0.4 (モメンタム効果はレジーム依存の傾向が強い、regime.trend=upとの交互作用が本命)。期待DSR: 中。期待p_perm: 低〜中。

#### 4.5 funding-rate-mean-reversion (crowded long側から着手)
```json
{
  "when": {"cmp": [{"feature": "funding_z_30d"}, ">", 2]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "48h"},
  "direction": "short"
}
```
- 使用feature: `funding_z_30d` / 評価期間: 全期間
- **counter_evidence 必須記載**: `cost_model.funding_included` は現状バックテストに反映されない (§1.3)。funding保有系Edgeの実際の経済性はfunding受け取り分だけ過小評価される (このEdgeはshort方向でfundingを受け取る側なので、実際の期待値は本評価より高くなる可能性がある — 保守的な方向のバイアス)。
- symmetric版 (funding_z_30d < -2 → long) はPhase 1完了後、同一edge_idのバージョン違いとして追加。
- 期待Sharpe: 0.3-0.6 (funding平均回帰は実務でも比較的再現性が高い)。期待DSR: 中〜高。期待p_perm: 低。

#### 4.6 open-interest-price-divergence
```json
{
  "when": {"and": [{"cmp": [{"feature": "ret_24h"}, ">", 0]}, {"cmp": [{"feature": "oi_chg_24h"}, "<", -3]}]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "24h"},
  "direction": "short"
}
```
- 使用feature: `ret_24h`, `oi_chg_24h` / 評価期間: 全期間
- 期待Sharpe: 0.2-0.5、期待DSR: 中、期待p_perm: 低〜中。

#### 4.7 top-trader-long-short-ratio-extremes
```json
{
  "when": {"cmp": [{"feature": "ls_top_trader_z_30d"}, ">", 2]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "48h"},
  "direction": "short"
}
```
- 使用feature: `ls_top_trader_z_30d` / 評価期間: 全期間 (ただしこの特徴量はTASK-3のbinance.vision `metrics`バックフィルに依存しており、2026-07-04時点でD1が0件 — §5のデータ依存注記を参照)
- 期待Sharpe: 0.1-0.3、期待DSR: 低〜中 (新規性・データ不確実性が高い)、期待p_perm: 中。

### Phase 2 (新規FeatureDef追加のみ、2件)

#### 4.8 weekly-breakout-continuation
- 前提作業: `registry.py` に `FeatureDef("weekly_high_dist", "high,close", "1h", 168, "price", lambda df: ops.rolling_high_dist(df["high"], df["close"], 168))` を1行追加 (**新規opは不要**、既存の`rolling_high_dist`をwindow=168で再利用するだけ)。
```json
{
  "when": {"cmp": [{"feature": "weekly_high_dist"}, ">", -1]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "72h"},
  "direction": "long"
}
```
- (weekly_high_distが-1%以内=直近高値更新に近い状態を「ブレイクアウト」の代理とする)
- 期待Sharpe: 0.1-0.3、期待DSR: 低、期待p_perm: 中〜高 (ブレイクアウト継続系は「継続」と「フェード」で文献が割れる、falsificationの価値もある)。

#### 4.9 round-number-price-clustering (優先度最低、falsification目的)
- 前提作業: `ops.py` に `round_number_dist(close, round_size=1000)` を新規追加 (単純な `close % round_size` ベースの距離計算)。
```json
{
  "when": {"cmp": [{"feature": "round_number_proximity"}, "<", 0.5]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "4h"},
  "direction": "long"
}
```
- 原仮説は「ラウンドナンバー到達後に有意なパターンはない」という**null予測**。REJECT verdictが出ること自体が仮説の確認になる。

### Phase 3 (econ_calendar データ投入のみ、3件)

前提: `workers/ingest/src/adapters/econ-calendar.ts` の `ECON_CALENDAR` 配列に、federalreserve.gov (FOMC) / bls.gov (CPI/PPI) の公式日程を投入する。**コード変更は不要、データ投入のみ**。

#### 4.10 pre-fomc-drift
```json
{
  "when": {"event": {"type": "fomc", "min_magnitude": 0}},
  "entry": {"delay_bars": -24, "price": "open"},
  "exit": {"horizon": "24h"},
  "direction": "long"
}
```
- **注意**: 原仮説は「FOMC**前日**の上昇」であり、現行DSLの `event` ノードは「イベント発生時刻に発火」する設計 (delay_bars は正の遅延のみを想定、負のdelay_barsで発表前に仕込む設計は evaluator.py の `_lag_index` が対応しているか要確認 — Sonnetへの実装確認事項として明記)。対応していない場合、FOMC日時から1日前のtsを持つ疑似イベントを`econ_calendar`側で生成する代替案が必要。
- 使用event: `fomc` (magnitude未設定、`econ_calendar.ts`のEconCalendarEntryにmagnitudeフィールド追加が必要かもPhase3実装時に確認)

#### 4.11 sell-the-news-fomc-drift
```json
{
  "when": {"event": {"type": "fomc", "min_magnitude": 0}},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "48h"},
  "direction": "short"
}
```
- 期待Sharpe: 0.2-0.4 (FOMC後ドリフトはマクロ市場で再現性のある効果として文献も多い)。期待DSR: 中。期待p_perm: 低〜中。

#### 4.12 cpi-macro-print-volatility-compression
```json
{
  "when": {"and": [{"event": {"type": "cpi_release", "min_magnitude": 0}}, {"cmp": [{"feature": "rv_24h"}, "<", {"feature": "rv_30d_pctile_1y"}]}]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "24h"},
  "direction": "long"
}
```
- **注意**: `cmp`の右辺にfeatureを置く比較 (`rv_24h` vs `rv_30d_pctile_1y`) は単位が揃っていない (前者は生のボラ値、後者は0-100のパーセンタイル順位) ため、この比較は成立しない。正しくは「発表前にrv_24hが自身の30dパーセンタイル順位で見て低い」ことを表現する必要があり、`rv_24h`のパーセンタイル特徴量 (`rv_pctile_24h`相当) が別途必要 — **これはPhase2相当の追加作業であり、Phase3への分類を再検討する要修正事項**として明記する。当面はイベント発生時のボラティリティ変化を`rv_24h`のchg (`event`前後比較) で捉える簡易版に置き換えるのがSonnetへの引き継ぎ事項。

### Phase 4 (options_surface統合、1件・要承認)

#### 4.13 variance-risk-premium-vrp-selling
- 前提作業: `features_sync.py`に`options_surface`からdvolを読み込むマージ処理を追加 (TASK-3の`_merge_deriv_columns`と同型)。新規FeatureDef: `vrp = dvol - rv_30d` (要: `rv_30d`という30d実現ボラfeatureが現registryに存在しないため、これも新規追加が必要 — 既存`realized_vol` opをwindow=30*24で呼ぶだけ)。
```json
{
  "when": {"cmp": [{"feature": "vrp"}, ">", 5]},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "168h"},
  "direction": "short"
}
```
- (VRPが正に大きい=IVが実現ボラを大きく上回る状態でボラ売り。実際の「売り」はオプションポジションだが、このEdgeはDSL/EEPの株式的売買モデルでは正確に表現できない — **オプションのプレミアム収益はスポット/perpの方向性トレードと損益構造が根本的に異なるため、現行の`direction: short`のスポット/perpモデルでは正しくバックテストできない**。この点は本Edgeが抱える構造的な限界であり、Sonnetへ「EEP/backtest.pyのオプション損益対応」が必要という課題として引き継ぐ。
- 期待Sharpe: 現行の近似モデルでは信頼度低 (上記の構造的限界のため)。真の評価にはオプション損益モデルの拡張が前提。

### Phase 5 (DSL day-of-month拡張、1件・最も影響範囲が広い)

#### 4.14 month-end-rebalance-flow
- 前提作業: `packages/schema`のBoolExpr型に`time.dom_in` (または`days_from_month_end`) を追加 → `research/.../dsl/evaluator.py`と`workers/ingest/src/signals/dsl-evaluator.ts`の両方に実装 → golden vector (docs/11 §4) 更新。
```json
{
  "when": {"time": {"dom_in": [28, 29, 30, 31, 1, 2]}},
  "entry": {"delay_bars": 1, "price": "open"},
  "exit": {"horizon": "48h"},
  "direction": "long"
}
```
- (月末最終3日+月初2日を「月末リバランス窓」の代理とする。月によって日数が異なるため`dom_in`はマイナス指定 (月末からのオフセット) をサポートする設計の方が頑健 — 実装詳細はSonnetへの設計課題として引き継ぐ)
- 期待Sharpe: 0.1-0.3、期待DSR: 低、期待p_perm: 中。

---

## 5. 難易度・期待値一覧

| Phase | Edge | 実装難易度 | 必要データ | 期待Sharpe | 期待DSR | 期待p_perm |
|---|---|---|---|---|---|---|
| 1 | funding-settlement-microstructure-pattern | ゼロ | candles のみ | ~0.0 | 低 | 高 (REJECT想定) |
| 1 | monday-asia-open-effect | ゼロ | candles のみ | 0.0-0.2 | 低 | 中〜高 |
| 1 | nyse-open-day-of-week-effect (簡易) | ゼロ | candles のみ | 0.0-0.2 | 低 | 中〜高 |
| 1 | price-momentum-continuation | ゼロ | ret_24h | 0.2-0.4 | 中 | 低〜中 |
| 1 | funding-rate-mean-reversion | ゼロ | funding_z_30d | 0.3-0.6 | 中〜高 | 低 |
| 1 | open-interest-price-divergence | ゼロ | ret_24h, oi_chg_24h | 0.2-0.5 | 中 | 低〜中 |
| 1 | top-trader-long-short-ratio-extremes | ゼロ | ls_top_trader_z_30d (**要backfill確認**) | 0.1-0.3 | 低〜中 | 中 |
| 2 | weekly-breakout-continuation | 極小 (FeatureDef 1行) | high, close | 0.1-0.3 | 低 | 中〜高 |
| 2 | round-number-price-clustering | 極小 (新規op 1本) | close | ~0.0 (null想定) | 低 | 高 (REJECT想定) |
| 3 | pre-fomc-drift | 極小 (データ投入) + 要DSL確認 | econ_calendar(fomc) | 不明 (負delay要検証) | - | - |
| 3 | sell-the-news-fomc-drift | 極小 (データ投入) | econ_calendar(fomc) | 0.2-0.4 | 中 | 低〜中 |
| 3 | cpi-macro-print-volatility-compression | 小 (要feature追加、分類要修正) | econ_calendar(cpi), rv系 | 未評価 (spec要修正) | - | - |
| 4 | variance-risk-premium-vrp-selling | 小〜中 (Feature Store統合+オプション損益モデル課題) | options_surface.dvol | 信頼度低 (構造的限界) | - | - |
| 5 | month-end-rebalance-flow | 中 (3パッケージ横断+golden vector) | candles のみ (dom_in拡張後) | 0.1-0.3 | 低 | 中 |

**注**: 期待値はすべて事前分布としての粗い見積りであり、保証ではない。EEPが実際に何を返すかがこの計画の目的そのものであり、期待値と乖離すること自体が有益な情報である。

---

## 6. Paper Trading への接続設計

### 6.1 既存実装の確認結果 (追加コード不要な部分)

`apps/api/src/services/edge-lifecycle.ts` の状態機械は以下を**すでに正しく実装済み**:
- CANDIDATE→TESTING: `screen run`の`overall.ev_bps > 0 かつ overall.p_perm < 0.20` (docs/05 §2 の記述と完全一致)
- TESTING→VALIDATED: `full run`のverdict = ADOPT
- VALIDATED→PAPER: ユーザー操作 (ガード条件なし)
- PAPER→ACTIVE: `paper_signals`から30日以上・10シグナル以上・ペーパーSharpe ≥ OOS Sharpe 95%CI下限 (片側) を判定

→ Edge Pack v1 のどのEdgeがVALIDATEDに到達しても、**このゲート自体は無改修で動く**。

### 6.2 発見した致命的な欠落 (この計画の実行前提として明記)

`paper_signals`テーブルへの書き込み処理が**リポジトリ全体に一つも存在しない**。`nightly.py`のdocstringが将来の依存として言及するのみ。つまり:
- VALIDATED→PAPER は可能 (ガード条件がユーザー操作のみのため)
- しかしPAPER状態になった瞬間から、誰もそのEdgeのsignal_specを日次で評価してpaper_signalsに記録する仕組みがない
- 結果、**PAPER→ACTIVEは永久に成立しない** (`closed.length === 0`のため`paperPerformance()`が常にnullを返す)

これは監査ロードマップの**TASK-6 (paper trading配線, W8-9, 未着手)** そのものである。Edge Pack v1のどのEdgeも、TASK-6が実装されない限りACTIVEへ到達できない。

### 6.3 Edge Pack v1 実行順序への影響

Edge Pack v1 (本計画) は「IDEA→CANDIDATE→TESTING→VALIDATED」までを対象とし、**PAPER以降はTASK-6完了後に自然に接続される設計**とする。具体的には:
1. Phase 1-5 の各Edgeについて、IDEA→CANDIDATE (hypothesis/rationale/edge_version v1 は既に `edges` テーブルに存在するので、hypothesis/rationaleは埋まっている前提 — 要確認: counter_evidence列の埋まり具合次第でCANDIDATE遷移がブロックされる可能性あり) → screen run → (合格すれば) TESTING → full run → (ADOPTなら) VALIDATED、までをこの計画のスコープとする。
2. VALIDATED以降は、TASK-6実装後に既存の状態機械へ**無改修で**接続される。Edge Pack v1側で先回りしてPAPER以降の設計をする必要はない (既存設計がそのまま使える)。
3. Sonnetへの引き継ぎ事項として、「TASK-6着手時はEdge Pack v1でVALIDATEDに到達したEdgeを最初のpaper_signals実データ供給源として使う」ことを明記する。

---

## 7. Sonnet (次回実装セッション) への引き継ぎタスクリスト

**設計のみ、コードは書かない。次のタスクは優先順位順**:

1. Phase 1: `edges`テーブルの counter_evidence 列が7件とも埋まっているか確認 (IDEA→CANDIDATE ガード条件)。埋まっていなければ先にそこを埋める。
2. Phase 1: 4.1-4.7 の7件、`POST /edges/{id}/versions` (既存API) で signal_spec を投入し、`POST /edges/{id}/eval` (kind=screen) でscreen runをトリガー。
3. Phase 1実行前に、`top-trader-long-short-ratio-extremes`が依存する`ls_top_trader_z_30d`のD1実データ件数を確認 (TASK-3のbinance.vision `metrics`バックフィルが実際にデータを取得できているか、2026-07-04時点で0件だった経緯を踏まえて再確認)。
4. Phase 2: `registry.py`に`weekly_high_dist` FeatureDefと`round_number_dist` op + FeatureDefを追加。
5. Phase 3: `econ-calendar.ts`の`ECON_CALENDAR`に実データを投入。同時に`pre-fomc-drift`の負delay_bars対応可否をevaluator.pyで確認し、対応していなければ設計変更。`cpi-macro-print-volatility-compression`のsignal_spec単位不整合を修正。
6. Phase 4着手前に、docs/09 §3のvrp-monitor行を更新するかどうかユーザーに確認 (§3.2の前倒し判断)。
7. Phase 5着手前に、`packages/schema`のBoolExpr型変更が他の消費者 (web UIのsignal_spec表示等) に影響しないか確認。
8. 全Phase共通: 各signal_spec投入後、`research-on-demand.yml`をトリガーしscreen run結果を確認 → CANDIDATE→TESTING遷移を`edge_transitions`で確認。
9. TASK-6 (paper trading配線) 未着手である旨をロードマップに反映し、VALIDATEDに到達したEdgeがそこで滞留する想定であることをユーザーに周知。
