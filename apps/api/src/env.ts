// Cloudflare binding surface for the api Worker (docs/01 §4.1).

export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  LAKE: R2Bucket;
  ASSETS: Fetcher;

  // Cloudflare Access (Zero Trust Free) — docs/01 §5.
  ACCESS_TEAM_DOMAIN?: string; // e.g. "my-team.cloudflareaccess.com"
  ACCESS_AUD?: string; // Application Audience tag

  RESEARCH_API_TOKEN?: string;
  GITHUB_PAT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}
