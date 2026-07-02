import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Guards `/internal/*` — only research-worker (GitHub Actions) should call these (docs/01 §5). */
export const requireInternalToken: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.RESEARCH_API_TOKEN;
  if (!expected) {
    return c.json(
      { type: "about:blank", title: "RESEARCH_API_TOKEN not configured", status: 500 },
      500
    );
  }
  const header = c.req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !timingSafeEqual(provided, expected)) {
    return c.json({ type: "about:blank", title: "invalid internal token", status: 401 }, 401);
  }
  await next();
};
