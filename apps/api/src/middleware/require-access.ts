import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";
import { AccessAuthError, verifyAccessJwt } from "./access-jwt.js";

export interface AccessVariables {
  userEmail: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header Cloudflare Access attaches
 * to every request that made it through the Access policy (docs/01 §5).
 *
 * If ACCESS_TEAM_DOMAIN/ACCESS_AUD aren't configured, behavior depends on
 * ENVIRONMENT:
 * - Outside production (fresh clone, `wrangler dev`): skip verification
 *   with a warning header, so local dev works before Access is set up.
 * - In production (ENVIRONMENT=production, wrangler.jsonc `vars`): reads
 *   are still allowed unverified (Access itself may be in front doing the
 *   gating, docs/01 §5), but mutating requests fail closed with 401 rather
 *   than silently accepting unauthenticated writes — a deploy that forgot
 *   to configure Access must not become an open write API (docs/10 review,
 *   2026-07).
 */
export const requireAccess: MiddlewareHandler<{ Bindings: Env; Variables: AccessVariables }> = async (
  c,
  next
) => {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ENVIRONMENT } = c.env;
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
    if (ENVIRONMENT === "production" && !SAFE_METHODS.has(c.req.method)) {
      return c.json(
        {
          type: "about:blank",
          title: "Cloudflare Access is not configured; mutating requests are rejected in production",
          status: 401
        },
        401
      );
    }
    c.header("x-cryptoedge-auth", "unverified-dev-mode");
    c.set("userEmail", "dev@localhost");
    await next();
    return;
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    return c.json({ type: "about:blank", title: "missing Access assertion", status: 401 }, 401);
  }
  try {
    const claims = await verifyAccessJwt(token, ACCESS_TEAM_DOMAIN, ACCESS_AUD);
    c.set("userEmail", claims.email);
  } catch (err) {
    const message = err instanceof AccessAuthError ? err.message : "auth verification failed";
    return c.json({ type: "about:blank", title: message, status: 401 }, 401);
  }
  await next();
};
