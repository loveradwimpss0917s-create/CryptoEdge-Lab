-- 0003: register the coingecko data source, and make open_interest.oi_base
-- nullable. Binance's own REST API (source binance_rest) turned out to
-- actively block Cloudflare Workers' shared egress IPs (HTTP 403/451 —
-- docs/03 §2.1 already flagged this as a risk), so ingest now sources
-- Binance's funding rate / open interest via CoinGecko's public
-- /derivatives endpoint, which reports open interest in USD only (no
-- base-asset quantity) — oi_base can no longer always be populated.

INSERT INTO data_sources (source_id, name, tier, requires_key, status) VALUES
  ('coingecko', 'CoinGecko public API', 'free', 0, 'active');

CREATE TABLE open_interest_new (
  instrument_id   TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  oi_base         REAL,
  oi_usd          REAL,
  ingested_at     INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, ts)
);
INSERT INTO open_interest_new SELECT * FROM open_interest;
DROP TABLE open_interest;
ALTER TABLE open_interest_new RENAME TO open_interest;
