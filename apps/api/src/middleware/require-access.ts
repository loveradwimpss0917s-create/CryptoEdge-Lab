import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";
import { AccessAuthError, verifyAccessJwt } from "./access-jwt.js";

export interface AccessVariables {
  userEmail: string;
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header Cloudflare Access attaches
 * to every request that made it through the Access policy (docs/01 §5).
 * If ACCESS_TEAM_DOMAIN/ACCESS_AUD aren't configured yet (fresh clone,
 * local dev), auth is skipped with a warning header rather than failing
 * closed — this keeps `wrangler dev` usable before Access is set up, while
 * still being unambiguous in the response that no verification happened.
 */
export const requireAccess: MiddlewareHandler<{ Bindings: Env; Variables: AccessVariables }> = async (
  c,
  next
) => {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD } = c.env;
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
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
