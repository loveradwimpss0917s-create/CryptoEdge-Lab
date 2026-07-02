-- Reference/lookup seed data: instruments, data_sources, metric_defs.
-- Source of truth: docs/03_DATA_SOURCES.md §2-3. Needed up front because
-- edge_versions.instrument_id and metric_defs.source_id are FKs.

INSERT INTO instruments (instrument_id, symbol, venue, kind, base, quote, is_active) VALUES
  ('BTCUSDT.BINANCE.PERP', 'BTCUSDT', 'BINANCE', 'perp', 'BTC', 'USDT', 1),
  ('BTCUSDT.BINANCE.SPOT', 'BTCUSDT', 'BINANCE', 'spot', 'BTC', 'USDT', 1),
  ('BTC1!.CME.FUT',        'BTC1!',   'CME',     'future', 'BTC', 'USD', 1),
  ('BTC-USD.COINBASE.SPOT','BTC-USD', 'COINBASE','spot', 'BTC', 'USD', 1),
  ('BTC-PERP.DERIBIT.OPT_INDEX', 'BTC', 'DERIBIT', 'option_index', 'BTC', 'USD', 1),
  ('ETHUSDT.BINANCE.PERP', 'ETHUSDT', 'BINANCE', 'perp', 'ETH', 'USDT', 1);

INSERT INTO data_sources (source_id, name, tier, requires_key, status) VALUES
  ('binance_rest',          'Binance REST',                'free', 0, 'active'),
  ('binance_data_vision',   'Binance data.binance.vision',  'free', 0, 'active'),
  ('bybit_rest',            'Bybit v5 REST',                'free', 0, 'active'),
  ('okx_rest',              'OKX v5 REST',                  'free', 0, 'active'),
  ('deribit_rest',          'Deribit public REST',          'free', 0, 'active'),
  ('coinbase_rest',         'Coinbase Exchange REST',       'free', 0, 'active'),
  ('upbit_rest',            'Upbit REST',                   'free', 0, 'active'),
  ('hyperliquid_api',       'Hyperliquid public API',       'free', 0, 'active'),
  ('yahoo_finance',         'Yahoo Finance (unofficial)',   'free', 0, 'active'),
  ('coinmetrics_community', 'Coin Metrics Community API',   'free', 0, 'active'),
  ('blockchain_info',       'blockchain.com Charts API',    'free', 0, 'active'),
  ('mempool_space',         'mempool.space API',            'free', 0, 'active'),
  ('alternative_me',        'alternative.me Fear & Greed',  'free', 0, 'active'),
  ('etherscan',             'Etherscan API',                'freemium', 1, 'active'),
  ('tronscan',              'Tronscan API',                 'freemium', 1, 'active'),
  ('defillama',             'DefiLlama API',                'free', 0, 'active'),
  ('farside_etf',           'Farside Investors (HTML)',     'free', 0, 'active'),
  ('sosovalue_api',         'SoSoValue free API',           'free', 0, 'active'),
  ('fred',                  'FRED API',                     'freemium', 1, 'active'),
  ('google_trends',         'Google Trends (unofficial)',   'free', 0, 'active'),
  ('cftc_cot',              'CFTC COT (official CSV)',      'free', 0, 'active'),
  ('econ_calendar',         'Manual/official economic calendar', 'free', 0, 'active'),
  ('coinglass_v4',          'CoinGlass (free tier)',        'freemium', 1, 'disabled');

-- metric_defs: subset transcribed from docs/03 §3 (extend as adapters land).
INSERT INTO metric_defs (metric_id, domain, name, unit, cadence, source_id, pit_lag_ms, revisable, retention_days, description) VALUES
  ('deriv.predicted_funding.binance',  'deriv', 'predicted_funding', 'ratio', '5m', 'binance_rest', 0, 0, 180, 'Predicted funding rate snapshot'),
  ('deriv.basis_3m_annualized.binance','deriv', 'basis_3m_annualized', 'ratio', '1h', 'binance_rest', 0, 0, NULL, 'Annualized 3M futures basis'),
  ('deriv.coinbase_premium_bps',       'deriv', 'coinbase_premium_bps', 'bps', '5m', 'coinbase_rest', 0, 0, 180, 'Coinbase/Binance premium'),
  ('deriv.kimchi_premium_bps',         'deriv', 'kimchi_premium_bps', 'bps', '1h', 'upbit_rest', 0, 0, NULL, 'Upbit/Binance premium adjusted by KRW/USD'),
  ('deriv.perp_spot_vol_ratio',        'deriv', 'perp_spot_vol_ratio', 'ratio', '1h', 'binance_rest', 0, 0, NULL, 'Perp vs spot traded volume ratio'),
  ('flow.etf_net_usd',                 'flow', 'etf_net_usd', 'usd', '1d', 'farside_etf', 84600000, 1, NULL, 'US spot BTC ETF daily net flow, T+1 09:30 ET lag'),
  ('flow.etf_cumulative_usd',          'flow', 'etf_cumulative_usd', 'usd', '1d', 'farside_etf', 84600000, 1, NULL, 'Cumulative ETF net flow (derived)'),
  ('stable.usdt_mcap',                 'flow', 'usdt_mcap', 'usd', '1d', 'defillama', 0, 1, NULL, 'USDT market cap'),
  ('stable.total_stable_mcap',         'flow', 'total_stable_mcap', 'usd', '1d', 'defillama', 0, 1, NULL, 'Total stablecoin market cap'),
  ('stable.ssr',                       'flow', 'ssr', 'ratio', '1d', 'defillama', 0, 1, NULL, 'Stablecoin Supply Ratio = btc_mcap/stable_mcap (derived)'),
  ('stable.usdt_peg_dev_bps',          'flow', 'usdt_peg_dev_bps', 'bps', '5m', 'binance_rest', 0, 0, 180, 'USDT/USDC peg deviation'),
  ('onchain.mvrv',                     'onchain', 'mvrv', 'ratio', '1d', 'coinmetrics_community', 86400000, 1, NULL, 'CapMVRVCur from Coin Metrics'),
  ('onchain.active_addresses',         'onchain', 'active_addresses', 'count', '1d', 'coinmetrics_community', 86400000, 1, NULL, 'AdrActCnt'),
  ('onchain.hashrate',                 'onchain', 'hashrate', 'index', '1d', 'blockchain_info', 0, 1, NULL, 'Network hash rate'),
  ('sent.fear_greed',                  'sent', 'fear_greed', 'index', '1d', 'alternative_me', 0, 0, NULL, 'Crypto Fear & Greed Index'),
  ('sent.trends_bitcoin',              'sent', 'trends_bitcoin', 'index', '1w', 'google_trends', 172800000, 1, NULL, '"bitcoin" search volume'),
  ('macro.dxy',                        'macro', 'dxy', 'index', '1d', 'fred', 0, 1, NULL, 'DTWEXBGS trade-weighted dollar index'),
  ('macro.m2',                         'macro', 'm2', 'index', '1w', 'fred', 0, 1, NULL, 'M2SL money supply'),
  ('macro.vix',                        'macro', 'vix', 'index', '1d', 'fred', 0, 1, NULL, 'VIXCLS'),
  ('macro.t10y2y',                     'macro', 't10y2y', 'index', '1d', 'fred', 0, 1, NULL, '10Y-2Y treasury spread'),
  ('macro.nasdaq_ret',                 'macro', 'nasdaq_ret', 'index', '1d', 'yahoo_finance', 0, 1, NULL, 'NQ=F daily return'),
  ('cot.leveraged_net',                'macro', 'cot_leveraged_net', 'count', '1w', 'cftc_cot', 259200000, 0, NULL, 'CFTC leveraged funds net position'),
  ('cot.asset_mgr_net',                'macro', 'cot_asset_mgr_net', 'count', '1w', 'cftc_cot', 259200000, 0, NULL, 'CFTC asset manager net position'),
  ('mining.puell_multiple',            'mining', 'puell_multiple', 'ratio', '1d', 'coinmetrics_community', 86400000, 1, NULL, 'Derived from CM miner revenue');
