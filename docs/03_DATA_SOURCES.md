# 03. データ収集設計 (Data Sources & Ingestion)

> 原則 (docs/00 §3-6): 無料 API のみで V1 を構成し、全ソースをアダプタで抽象化。有料ソースは差込みで追加 (docs/13 §6 のトリガー成立時のみ)。
> 全収集は docs/01 §3.1 のパイプライン (Cron tick → 直接 fetch、リトライは D1 `ingest_tasks`) に乗る。1 tick の外部 fetch は 40 本以下 (Free サブリクエスト制約)。

---

## 1. 調査サマリ: Edge になり得るデータの全体地図

| ドメイン | Edge との関係 (PDF 対応) | V1 | V2 | V3 |
|---|---|---|---|---|
| 現物/先物 OHLCV・出来高 | 全 Edge の土台。季節性 (018/019/020)、CME ギャップ (021) | ✅ | | |
| Funding / OI / L/S | レバレッジ構造系 (006/007/009/011/012) | ✅ | | |
| 清算 | カスケードリバウンド (006/008) | ✅ | | |
| 板 (スナップ) | マイクロ構造 (001/004)、流動性レジーム | ✅ | | |
| オプション (DVOL/スキュー/OI) | VRP (013/014/015)、ガンマ (016/017) | ✅ 基本 | ✅ 面全体 | |
| ETF フロー | 024/025/026 | ✅ | | |
| ステーブルコイン | USDT 発行 (031)、SSR (032/033)、デペグ (034) | ✅ | | |
| オンチェーン基礎 (無料) | 取引所フロー (028)、Whale (029/030)、MVRV/SOPR/NUPL | ✅ 無料範囲 | ✅ 有料 | |
| マクロ (DXY/M2/金利/株) | クロスアセット (035/036/037)。単独では弱く条件変数扱い (PDF 結論踏襲) | ✅ | | |
| イベントカレンダー (FOMC/CPI/SQ) | イベントドリブン (041/042/043/017) | ✅ | | |
| センチメント (F&G, Trends) | 行動系 (026/040) | ✅ | | |
| CFTC COT | 027 | ✅ | | |
| クロス取引所 (プレミアム/funding 乖離) | 024/050/052/053 | ✅ 主要 | ✅ 拡張 | |
| Hyperliquid オンチェーン板 | 051 | | ✅ | |
| DEX (DefiLlama volumes) | CEX/DEX シフト | | ✅ | |
| ニュース/SNS | イベント検知の補助。ノイズ多くコスト高 | | | ✅ |
| ティック/L2 深度録画 | 001/002/003/005 のフル検証 | | | ✅ |
| マイナー指標 | Miner reserve 系 (無料は Puell 等) | ✅ 無料範囲 | ✅ | |

---

## 2. ソースカタログ

### 2.1 取引所 (無料・キー不要中心)

| source_id | 提供 | 主要エンドポイント/ストリーム | レート制限 | 備考 |
|---|---|---|---|---|
| ~~`binance_rest`~~ | ~~Binance (spot+USD-M futures) 直叩き~~ | — | — | **2026-07 に運用中止**: Binance の WAF が Cloudflare Workers の共有 egress IP を HTTP 403 (`fapi.binance.com`) / 451 (`api.binance.com`) でブロックすることを確認。地域制限リスクは元々本表で警告していたが、実際には全リクエストが恒常的に失敗した。ヘッダ調整では回避不可 (クラウド/データセンター帯 IP そのものを狙った既知のブロック) |
| ~~`bybit_rest`~~ (tick-5m 用途) | ~~Bybit v5~~ | — | — | 同時期の到達性調査 (`diagnostics.ts`, 2026-07) で HTTP 403 を確認、Binance 同様ブロック対象。funding 乖離 (050) 用の冗長系としての将来利用は保留 |
| ~~`coingecko`~~ | ~~CoinGecko public API~~ | — | — | 2026-07 に一度 Binance の代替として採用したが、Cloudflare Workers 全体で egress IP を共有するため無料枠のレート制限 (10-30 req/min/IP) が他ユーザーの合算トラフィックで即座に枯渇し、初回リクエストから 403/429 が発生。**運用不可と判断し okx_rest へ再移行** |
| `okx_rest` | OKX v5 | `/api/v5/market/candles` (1m 足), `/api/v5/public/funding-rate`, `/api/v5/public/open-interest` | 20 req/2s | **tick-5m の主力ソース** (schedule.ts `makeOkxCandlesAdapter` / `makeOkxFundingRateAdapter` / `makeOkxOpenInterestAdapter`, 2026-07〜)。到達性調査で HTTP 200 を確認済み。既存の `instrument_id`(例 `BTCUSDT.BINANCE.PERP`)は edge_versions.signal_spec が直接参照するため据え置き — 価格は取引所間裁定でほぼ同値だが、funding/OI は実質 OKX の値である点に注意 (誤って「Binance の実データ」と読まないこと)。**単位/PIT 修正 (2026-07 レビュー, migration 0005)**: funding の `ts` は決済予定時刻(未来)ではなく取得時刻を使用し決済時刻は `meta.next_funding_time` へ退避。OI は契約枚数 (`oi`) ではなく基軸通貨建て (`oiCcy`) を `oi_base` に格納。先物 1m 足の出来高は契約枚数ではなく `volCcy`/`volCcyQuote` (基軸/建玉通貨) を使用。**429 対策 (2026-07 レビュー Task 6)**: 呼び出し間に 300-800ms のジッター (`jitterDelay`) を挟み、`fetchJson` は 429 を `Retry-After` (既定 1000ms) 待って 1 回だけ再試行する。継続的な 429 は DQ-02 の連続失敗閾値を 3→6 に緩和 (自己解消しやすいノイズのため、実障害と同列に警報しない) |
| `binance_data_vision` | data.binance.vision | 日次 ZIP (klines/aggTrades/fundingRate 等の全履歴) | 制限緩い | **ヒストリカル一括バックフィル専用**。research-worker が直接取得し R2 へ。到達性未確認 (静的ファイル配信なので REST WAF ブロックの対象外である可能性が高い) |
| `deribit_rest` | Deribit | `public/get_volatility_index_data` (DVOL), `public/get_book_summary_by_currency` (option OI/IV), `public/ticker`, `public/get_instruments` | 認証不要, 緩い | オプション系の中核 (013–017)。板サマリから RR25/ATM IV を ingest Worker で集計 |
| `coinbase_rest` | Coinbase Exchange | `/products/BTC-USD/candles`, `/products/BTC-USD/ticker` | 10 req/s | Coinbase プレミアム (024/053) |
| `upbit_rest` | Upbit | `/v1/candles/*`, ticker | 10 req/s | Kimchi プレミアム (052)。KRW/USD 換算は FRED |
| `hyperliquid_api` | Hyperliquid | `POST /info` (funding, OI, l2Book) | 緩い | 051。V2 |
| `cme_via_tvc` | CME BTC 先物 (021 用) | 直接 API なし。代替: (a) Yahoo Finance `BTC=F` 日足, (b) CoinGlass 先物, (c) TradingView 手動 CSV | — | **CME ギャップは金曜クローズ/日曜オープンの日足で計算可能** → Yahoo `BTC=F` で足りる。`yahoo_finance` アダプタで取得 |

### 2.2 デリバティブ集計・清算

| source_id | 提供 | 内容 | 制限 | 備考 |
|---|---|---|---|---|
| `binance_ws_forceorder` | Binance WS `!forceOrder@arr` | 清算イベント | WS | **注意 (PDF W7 関連)**: 2021-04 以降 1 秒 1 件のサンプリング配信で完全データではない。5m バケット集計し `source_id` を明示。V1 は定期 REST では取れないため、**V1 では CoinGlass 無料枠 + OKX rubik を主とし、WS 録画は V3** |
| `coinglass_v4` | CoinGlass (freemium) | 清算集計, OI 横断, L/S, ヒートマップ(有料) | 無料: 低頻度/主要指標 | 無料枠で 5m/1h 清算集計と横断 OI。ヒートマップ (008) は有料のため V2 判断 |
| `laevitas_free` | Laevitas (freemium) | デリバティブ集計の冗長系 | 低 | 任意 |

### 2.3 ETF フロー

| source_id | 提供 | 内容 | 備考 |
|---|---|---|---|
| `farside_etf` | Farside Investors (HTML 表) | 米スポット BTC/ETH ETF 日次フロー (発行体別) | スクレイピング (構造単純)。`pit_lag` = T+1 朝。`revisable=1` |
| `sosovalue_api` | SoSoValue (free API) | ETF フロー/AUM | フォールバック兼クロスチェック (二重化, docs/03 §6 DQ-07) |

### 2.4 オンチェーン (無料枠)

| source_id | 提供 | 内容 | 備考 |
|---|---|---|---|
| `coinmetrics_community` | Coin Metrics Community API | 日次: AdrActCnt, TxTfrValAdjUSD, CapMVRVCur (MVRV), SplyAct1yr, FeeTotUSD, HashRate 等 ~40 系列 | **無料オンチェーンの本命**。CSV/JSON、キー不要 |
| `blockchain_info` | blockchain.com Charts API | hash-rate, miners-revenue, mempool, n-transactions | 無料・安定 |
| `mempool_space` | mempool.space API | fee 環境, mempool 混雑 | 無料 |
| `alternative_me` | alternative.me | Fear & Greed Index (日次) | 無料。026 |
| `etherscan` / `tronscan` | Etherscan/Tronscan (free key) | USDT Treasury ミント/バーン検知 (031)。対象アドレスの大口 Transfer 監視 | 5 req/s (free)。イベント → `events(usdt_mint)` |
| `whale_alert_free` | Whale Alert (free tier) | 大口転送 (029) | 無料枠は遅延あり。V1 は USDT 系のみ etherscan/tronscan で自前検知し、Whale Alert は V2 |
| `defillama` | DefiLlama | stablecoin 時価総額 (032/033), DEX volumes, TVL | 無料・キー不要 |
| `cryptoquant` / `glassnode` | (有料) | Exchange Reserve, SOPR, NUPL, Whale Ratio, Miner flows | **V2 で有料化判断**。V1 では metric_defs だけ予約登録し、Coin Metrics で代替可能なもの (MVRV 等) は無料系で開始 |

SOPR/NUPL/Exchange Reserve の V1 方針: 正確な取引所ラベル付きデータは有料でしか得られない。V1 は (a) MVRV = Coin Metrics 無料, (b) Exchange netflow の代理として「主要取引所既知アドレスの残高」は追わず、**ステーブルコイン供給 + ETF フローを法定通貨流入の代理変数とする**。SOPR/NUPL は V2 の有料契約後に追加 (metric_defs 予約済みなのでスキーマ変更不要)。

### 2.5 マクロ・株式・センチメント・イベント

| source_id | 提供 | 内容 | 備考 |
|---|---|---|---|
| `fred` | FRED API (free key) | DXY (DTWEXBGS), M2SL, FEDFUNDS, T10Y2Y, VIXCLS, KRW/USD | 日次/週次。`revisable=1` (M2 等は改訂あり) |
| `yahoo_finance` | Yahoo Finance (非公式) | NQ=F, ES=F, GC=F, BTC=F (CME), ^VIX 日中 | 非公式ゆえ冗長系必須 (Stooq CSV をフォールバック)。ToS リスクは docs/10 R-D2 |
| `google_trends` | Google Trends (非公式 API) | "bitcoin" 等の検索量 (040) | 週次で十分。403 多発時は SerpAPI (有料) へ差替え可能なアダプタ設計 |
| `cftc_cot` | CFTC (公式 CSV) | COT レポート (BTC futures, Leveraged Funds / Asset Manager) (027) | 週次金曜発表 (火曜締め)。`pit_lag` = 3 日**必須** |
| `econ_calendar` | 手動シード + 公式ソース | FOMC (Fed 公式カレンダー年次固定), CPI/NFP (BLS スケジュール), Deribit 限月 SQ (計算可能), 半減期 | 年 1 回の手動更新 + ingest 自動補完。`events` へ |

### 2.6 V3 候補 (設計のみ、実装しない)

Kaiko/Amberdata (板ヒストリカル)、Tardis.dev (ティック録画)、X/Reddit センチメント、Nansen (スマートマネー)、Santiment。すべてアダプタ追加のみで載る。

---

## 3. metric_defs 初期登録 (抜粋 — 実装時はこの表を完全転記)

| metric_id | cadence | source | unit | pit_lag | revisable |
|---|---|---|---|---|---|
| `deriv.predicted_funding.binance` | 5m | binance_rest | ratio | 0 | 0 |
| `deriv.basis_3m_annualized.binance` | 1h | binance_rest | ratio | 0 | 0 |
| `deriv.coinbase_premium_bps` | 5m | coinbase+binance | bps | 0 | 0 |
| `deriv.kimchi_premium_bps` | 1h | upbit+binance+fred | bps | 0 | 0 |
| `deriv.perp_spot_vol_ratio` | 1h | binance_rest | ratio | 0 | 0 |
| `flow.etf_net_usd` | 1d | farside_etf | usd | T+1 09:30ET | 1 |
| `flow.etf_cumulative_usd` | 1d | (派生) | usd | 同上 | 1 |
| `stable.usdt_mcap` / `stable.total_stable_mcap` | 1d | defillama | usd | 0 | 1 |
| `stable.ssr` | 1d | 派生 (btc_mcap/stable_mcap) | ratio | 0 | 1 |
| `stable.usdt_peg_dev_bps` | 5m | binance_rest (USDC/USDT) | bps | 0 | 0 |
| `onchain.mvrv` | 1d | coinmetrics_community | ratio | T+1 | 1 |
| `onchain.active_addresses` ほか CM ~20 系列 | 1d | coinmetrics_community | count | T+1 | 1 |
| `onchain.hashrate` | 1d | blockchain_info | index | 0 | 1 |
| `sent.fear_greed` | 1d | alternative_me | index | 0 | 0 |
| `sent.trends_bitcoin` | 1w | google_trends | index | 2d | 1 |
| `macro.dxy` / `macro.m2` / `macro.vix` / `macro.t10y2y` / `macro.nasdaq_ret` | 1d | fred / yahoo | index | 系列別 | 1 |
| `cot.leveraged_net` / `cot.asset_mgr_net` | 1w | cftc_cot | count | 3d | 0 |
| `mining.puell_multiple` | 1d | 派生 (CM miner revenue) | ratio | T+1 | 1 |

派生メトリクス (`ssr`, `coinbase_premium` 等) は ingest Worker が入力取得時に同期計算して `metrics` に書く。定義は `metric_defs.description` に数式で明記する。

---

## 4. 日次収集の実行順序 (tier-1d, 01:23 UTC)

依存があるため順序制御する (Queue メッセージに `depends_on` は持たせず、ingest Worker が 3 段のグループを 5 分間隔で投入):

1. **G1 (独立取得)**: coinmetrics, blockchain_info, defillama, alternative_me, fred, yahoo, farside/sosovalue, cftc (金曜のみ), google_trends (月曜のみ)
2. **G2 (派生計算)**: ssr, puell, etf_cumulative, kimchi (KRW レート依存)
3. **G3 (検査・確定)**: 日次 DQ 検査 (§6) → `events` 抽出 (etf_flow_extreme 等) → research dispatch の前提フラグを KV に立てる

---

## 5. バックフィル戦略 (初期データ投入)

V1 セットアップ時に research-worker (GitHub Actions, 手動トリガ) が一括実行:

| データ | 期間 | 手段 |
|---|---|---|
| Binance klines (1m/1h/1d, spot+perp) | 2017-08〜 (1m は 2020-01〜) | data.binance.vision ZIP → R2 Parquet。1h/1d と直近 90 日の 1m を D1 へ。**実装済み** (`jobs/lake_sync.py`, `.github/workflows/lake-sync.yml`, 2026-07 レビュー Task 4): 1回の実行は未取得分のみ日数上限付きで取得 (1m=30日/回, 1h/1d=365日/回) し、初期の複数年分は手動連打 + 週次自動実行で徐々に完了させる |
| funding / OI hist | 提供範囲全部 (funding 2019-09〜) | REST ページング |
| DVOL | 2021-03〜 | deribit REST |
| Coin Metrics 日次 | 2010〜 | community CSV |
| FRED / F&G / DefiLlama / COT | 全履歴 | 各 API |
| ETF フロー | 2024-01〜 | farside 全表 |
| CME 日足 (BTC=F) | 2017-12〜 | yahoo |
| USDT mint イベント | 2020〜 | Tronscan/Etherscan の Treasury アドレス走査 |

バックフィル完了の定義: 各 stream の `ingest_state.watermark_ts` が現在時刻-1 tier 以内、かつ DQ 検査パス。

**無料枠スロットリング (docs/13 §1)**: ヒストリカルの主保存先は R2 Parquet (D1 書込枠を消費しない)。D1 へ入れるのは 1h/1d と直近ホット期間のみとし、`/internal` 経由の投入は **80K 行/日** 以下に分割して数日かけて流す (D1 Free 書込 100K 行/日)。

---

## 6. データ品質管理 (ingest Worker 内 + 日次バッチ)

| Rule | 内容 | severity | アクション |
|---|---|---|---|
| DQ-01 gap | 時系列の欠損 (期待 cadence に対する穴) | warn / critical (>3 本) | 自動リフィル試行 → 失敗で issue |
| DQ-02 stale | watermark が cadence×3 超過 | critical | ソース degraded + 通知 |
| DQ-03 spike | 値が過去 90 日分布の 8σ 超 | warn | 保存はする (本物のテールかもしれない)。フラグ付け、AI 品質監視 (docs/07 §5) が文脈判定 |
| DQ-04 schema | 外部 API レスポンスの zod 検証失敗 | critical | 保存せず DLQ |
| DQ-05 duplicate | dedupe_key / PK 衝突で値が不一致 | warn | 新 ingested_at 行として保存 (二時制が吸収) |
| DQ-06 unit | 単位妥当性 (負の出来高、ratio>1 等) | critical | 保存せず issue |
| DQ-07 cross-source | 二重化ソース間乖離 (ETF フロー: farside vs sosovalue > 5%) | warn | 両方保存 + issue。研究では primary を使用 |
| DQ-08 pit | `ts > ingested_at` (未来データ) | critical | 保存せず issue (look-ahead 汚染防止) |
| DQ-09 revision | revisable 系列の大幅改訂 (>10%) | info | 記録。改訂頻度は Data Health 画面に表示 |
| DQ-10 quota | `quota_usage` の当日使用率が budget の 80% 超 (2026-07 レビュー Task 7) | critical | resource+日付単位で1回だけ記録 + Telegram 通知 (ingest tick 毎に自己監視) |

品質スコア: stream ごとに `直近30日の (取得成功率 × 欠損なし率)` を日次計算し D1 `latest_snapshots` へ (Data Health 画面 SCR-05 の主表示)。KV には置かない (書込枠 1,000/日 の温存, docs/13 §1)。

---

## 7. アダプタ設計 (ingest Worker 内の共通インターフェイス)

各アダプタ (workers/ingest/src/adapters/*.ts) は以下を実装する。実装契約 (擬似シグネチャ — 実コードは実装フェーズで):

```
Adapter {
  sourceId: string
  streams: StreamDef[]           // {stream, cadence, instruments?, buildRequest(window),
                                 //  parse(raw): NormalizedRow[], target: 'candles'|'metrics'|...}
  rateLimit: {perMin, weight?}   // D1 カウンタで ingest が強制 (KV 書込枠温存)
}
```

規約:
- **parse は純関数** (fetch と分離、ユニットテスト対象。docs/11 §2)
- 正規化行はテーブル別の zod スキーマ (packages/schema) を通してから書込み
- ページング/リトライ/バックオフは共通ランナー側で処理。アダプタは 1 ページの取得と解釈のみ
- フォールバックソース (yahoo→stooq, farside→sosovalue) は `streams` の `fallback_source_id` で宣言し、ランナーが自動切替
- 新ソース追加チェックリスト: ① data_sources 行 ② metric_defs 行 ③ アダプタ 1 ファイル ④ parse のユニットテスト ⑤ tier 表 (workers/ingest/src/schedule.ts) への登録 — **5 点だけで完結すること** (これが崩れる設計変更は拒否する)
