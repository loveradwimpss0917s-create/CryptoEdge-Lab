// Cloudflare binding surface for the api Worker (docs/01 §4.1).

export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  LAKE: R2Bucket;
  ASSETS: Fetcher;

  // "production" in wrangler.jsonc vars; anything else (unset, "development")
  // is treated as local/dev. Gates require-access's fail-open behavior —
  // see docs/10 §risks, the fail-open-in-prod finding from the 2026-07 review.
  ENVIRONMENT?: string;

  // Cloudflare Access (Zero Trust Free) — docs/01 §5.
  ACCESS_TEAM_DOMAIN?: string; // e.g. "my-team.cloudflareaccess.com"
  ACCESS_AUD?: string; // Application Audience tag

  RESEARCH_API_TOKEN?: string;
  GITHUB_PAT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}
