-- docs/19 S-02/S-91 follow-up: touchIngestState (workers/ingest/src/db.ts)
-- now auto-resolves a stream's open dq_issues the next time it ticks
-- successfully, but binance_rest/bybit_rest/coingecko were permanently
-- disabled by migration 0007 -- their streams will never tick again, so
-- their open dq_issues (one DQ-02 each, per 0007's own note) would sit
-- open forever despite representing an already-decided, permanent
-- migration to okx_rest rather than a live problem. Close them directly.
UPDATE dq_issues
SET status = 'resolved', resolved_at = strftime('%s', 'now') * 1000
WHERE status = 'open'
  AND (
    stream_id LIKE 'binance_rest:%'
    OR stream_id LIKE 'bybit_rest:%'
    OR stream_id LIKE 'coingecko:%'
  );
