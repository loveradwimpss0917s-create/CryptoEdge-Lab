-- 0006: Research Readiness (docs/06 §7, 2026-07 design). Adds the one
-- human/AI-curated input the readiness computation can't derive from
-- signal_spec/feature_defs/data alone: docs/14 (Edge Pack v1)'s A/B/C/D
-- classification of the 50 seed edges that have never had a signal_spec
-- authored. NULL (the default for any edge created after this migration,
-- including the 4 that already have a version) means "unclassified" --
-- readiness.ts treats that as SIGNAL_SPEC_PENDING, not a block.

ALTER TABLE edges ADD COLUMN readiness_class TEXT; -- 'A'|'B'|'C'|'D'
ALTER TABLE edges ADD COLUMN readiness_blockers TEXT; -- JSON string[], only meaningful for C/D

-- A: 今すぐ評価可能 (7件) -- docs/14 §4.1-4.7 で signal_spec 設計済み。
UPDATE edges SET readiness_class = 'A' WHERE slug IN (
  'price-momentum-continuation',
  'funding-rate-mean-reversion',
  'funding-settlement-microstructure-pattern',
  'open-interest-price-divergence',
  'top-trader-long-short-ratio-extremes',
  'monday-asia-open-effect',
  'nyse-open-day-of-week-effect'
);

-- B: 小さな追加のみで評価可能 (7件) -- docs/14 §4.8-4.14。
UPDATE edges SET readiness_class = 'B' WHERE slug IN (
  'round-number-price-clustering',
  'cpi-macro-print-volatility-compression',
  'pre-fomc-drift',
  'sell-the-news-fomc-drift',
  'variance-risk-premium-vrp-selling',
  'weekly-breakout-continuation',
  'month-end-rebalance-flow'
);

-- D: Discovery Engine完成後 (5件) -- 単一の固定ルールでは仮説を代表できない。
UPDATE edges SET readiness_class = 'D', readiness_blockers = '["銘柄間の特徴量転移検証はDiscovery Engine向き"]'
  WHERE slug = 'eth-cross-sectional-feature-transfer-from-btc';
UPDATE edges SET readiness_class = 'D', readiness_blockers = '["GEXレジームの交互作用検証はDiscovery Engine向き"]'
  WHERE slug = 'dealer-gamma-exposure-gex-regime';
UPDATE edges SET readiness_class = 'D', readiness_blockers = '["GARCHモデル適合という新規統計手法が必要"]'
  WHERE slug = 'garch-volatility-regime-clustering';
UPDATE edges SET readiness_class = 'D', readiness_blockers = '["非対称ボラティリティの回帰分析はDiscovery Engine向き"]'
  WHERE slug = 'inverted-leverage-effect-btc-vol-asymmetry';
UPDATE edges SET readiness_class = 'D', readiness_blockers = '["Lee-Myklandジャンプ検定とOFIの交互作用検証が必要"]'
  WHERE slug = 'jump-dynamics-via-lee-mykland-detection';

-- C: 新しいデータソースが必要 (31件)。
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Google Trends データ未実装"]'
  WHERE slug = 'google-trends-overheat-fomo-fade';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["DXY (FRED) データ未実装"]'
  WHERE slug = 'dxy-correlation-regime';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["M2 (FRED) データ未実装"]'
  WHERE slug = 'global-m2-liquidity-linkage';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Nasdaq (yahoo_finance) データ未実装"]'
  WHERE slug = 'nasdaq-cross-asset-regime-linkage';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Bybit/Hyperliquid funding データ未実装"]'
  WHERE slug = 'cross-exchange-funding-divergence';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Hyperliquid API 未実装"]'
  WHERE slug = 'hyperliquid-on-chain-positioning-transparency';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Upbit データ未実装"]'
  WHERE slug = 'kimchi-premium-korea-exchange-spread';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["現物出来高との比較に必要な別instrument系列の設計が必要"]'
  WHERE slug = 'perp-spot-volume-ratio-leverage-regime';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Coinbase出来高データ未実装"]'
  WHERE slug = 'regional-cex-flow-divergence-coinbase-vs-binance';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["CFTC COT データ未実装"]'
  WHERE slug = 'cme-cot-positioning-reversal';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Coinbase価格データ未実装"]'
  WHERE slug = 'coinbase-premium-as-an-etf-flow-proxy';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["ETF フローデータ未実装"]'
  WHERE slug = 'etf-flow-sentiment-divergence';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["ETF フローデータ未実装"]'
  WHERE slug = 'etf-t-1-sell-pressure';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["複数instrument比較 (ETH/BTC比) のDSL/EEP拡張が必要"]'
  WHERE slug = 'altcoin-sideways-breakout-drift-btc-pair';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["価格帯別の清算密集度データ未実装"]'
  WHERE slug = 'liquidation-heatmap-magnet';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["取引所間ベーシス比較データ未実装"]'
  WHERE slug = 'three-exchange-basis-convergence';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["L2板データ未実装"]'
  WHERE slug = 'cross-exchange-ofi-lead-lag-coinbase-binance';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["CVD (累積出来高デルタ) 未実装"]'
  WHERE slug = 'cvd-price-divergence';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["板厚みデータ未実装"]'
  WHERE slug = 'order-book-depth-regression-on-spread-returns';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["OFIデータ・秒足粒度が未実装"]'
  WHERE slug = 'order-flow-imbalance-ofi-mid-price-prediction';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["VPIN 未実装"]'
  WHERE slug = 'vpin-based-jump-prediction';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["オンチェーンnetflowデータ未実装"]'
  WHERE slug = 'exchange-netflow-signal';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["オンチェーンwhaleデータ未実装"]'
  WHERE slug = 'exchange-whale-ratio';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["Whale Alert 未実装"]'
  WHERE slug = 'whale-alert-transfer-reaction';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["options_surface.rr25_1m 未収集"]'
  WHERE slug = '25-delta-risk-reversal-selling';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["options_surface.rr25_1m 未収集"]'
  WHERE slug = '25-delta-skew-as-a-realized-vol-forecaster';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["options_surface.max_pain 未収集", "限月カレンダー未実装"]'
  WHERE slug = 'options-expiry-sq-max-pain-gravitational-pull';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["ステーブルコイン供給データ未実装"]'
  WHERE slug = 'stablecoin-issuance-acceleration';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["ステーブルコイン供給データ未実装"]'
  WHERE slug = 'stablecoin-supply-ratio-ssr-low-reversal';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["USDT/USDCデペッグ検知データ未実装"]'
  WHERE slug = 'usdt-depeg-risk-off-signal';
UPDATE edges SET readiness_class = 'C', readiness_blockers = '["5分足粒度のFeature Store未実装 (現行は1h cadenceのみ)"]'
  WHERE slug = 'session-open-close-volatility-seasonality';
