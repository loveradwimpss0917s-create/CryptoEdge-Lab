-- Marks the exchange sources docs/03 §2.1 documents as permanently blocked
-- (Cloudflare Workers' shared egress IP pool gets HTTP 403/451 from all
-- three) as 'disabled' instead of the default 'active'. Found live via the
-- Data Health screen (docs/15 SONNET-4): with these left 'active', their
-- dead streams (0% quality, consecutive_errors=40, one open DQ-02 issue
-- each) counted toward overall_quality_score and cluttered the UI as if
-- they were current problems rather than a permanent, already-decided
-- migration to okx_rest.
UPDATE data_sources SET status = 'disabled' WHERE source_id IN ('binance_rest', 'bybit_rest', 'coingecko');
