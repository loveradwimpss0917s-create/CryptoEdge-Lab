// Cloudflare binding surface for the ingest Worker (docs/01 §4.1).
// Secrets (API keys) are declared here for typing but provisioned via
// `wrangler secret put` — never committed.

export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  LAKE: R2Bucket;

  // Free-tier keys (docs/13 §4). All optional at the type level because a
  // freshly-cloned repo has none configured yet; adapters that need one
  // must fail soft (skip + dq_issue) rather than throw when absent.
  FRED_API_KEY?: string;
  ETHERSCAN_API_KEY?: string;
  TRONSCAN_API_KEY?: string;

  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEARCH_API_TOKEN?: string;
  GITHUB_PAT?: string;
}
