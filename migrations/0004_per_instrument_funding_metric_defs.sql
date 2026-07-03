-- 0004: the ingest Worker's funding-rate adapter has always composed a
-- per-instrument metric_id (`deriv.predicted_funding.binance.{SYMBOL}`),
-- but 0002 only seeded the generic `deriv.predicted_funding.binance` row.
-- This FK gap was latent (Binance's own API was blocked before ever
-- reaching the D1 write — docs/03 §2.1), and only surfaced once the OKX
-- adapter (2026-07) actually got a successful response through.

INSERT INTO metric_defs (metric_id, domain, name, unit, cadence, source_id, pit_lag_ms, revisable, retention_days, description) VALUES
  ('deriv.predicted_funding.binance.BTCUSDT', 'deriv', 'predicted_funding', 'ratio', '5m', 'okx_rest', 0, 0, 180, 'Predicted funding rate snapshot (BTCUSDT)'),
  ('deriv.predicted_funding.binance.ETHUSDT', 'deriv', 'predicted_funding', 'ratio', '5m', 'okx_rest', 0, 0, 180, 'Predicted funding rate snapshot (ETHUSDT)');
