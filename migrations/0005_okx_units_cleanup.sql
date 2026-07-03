-- 0005: clean up the OKX unit/PIT bugs found in the 2026-07 review
-- (funding ts was a future settlement time, not an observation time;
-- open_interest.oi_base held OKX contract counts instead of base-currency
-- units; futures candle volume held contract counts instead of base-currency
-- volume). All three are now fixed in workers/ingest/src/adapters/okx.ts.
--
-- The contaminated rows are only a few hours old at this point, so the
-- cheapest correct fix is to delete and let ingest re-populate on the next
-- tick, rather than attempt an in-place unit conversion of a handful of rows.

DELETE FROM metrics WHERE metric_id LIKE 'deriv.predicted_funding.binance.%';
DELETE FROM open_interest;
DELETE FROM candles;

-- Real OKX-labeled instruments, distinct from the legacy Binance-labeled
-- ones the seeded edge_versions still reference (docs/03 §2.1). Existing
-- adapters keep writing under the Binance-labeled instrument_id for now;
-- these rows exist so future work can migrate signal_specs to the honest
-- label without an instruments FK gap.
INSERT INTO instruments (instrument_id, symbol, venue, kind, base, quote, is_active) VALUES
  ('BTCUSDT.OKX.PERP', 'BTC-USDT-SWAP', 'OKX', 'perp', 'BTC', 'USDT', 1),
  ('BTCUSDT.OKX.SPOT', 'BTC-USDT', 'OKX', 'spot', 'BTC', 'USDT', 1),
  ('ETHUSDT.OKX.PERP', 'ETH-USDT-SWAP', 'OKX', 'perp', 'ETH', 'USDT', 1);
