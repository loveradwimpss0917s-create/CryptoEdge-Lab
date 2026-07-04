// api Worker entry point (docs/01 §2.3, §6). Hono app serving `/api/v1/*`
// (Cloudflare Access protected) and `/internal/*` (Bearer-token protected,
// research-worker only); everything else falls through to the Static
// Assets binding, which serves the React SPA (docs/01 §4.1 — same Worker,
// so SPA requests don't count against the Free request quota... they do
// count, but they're free of D1/compute cost).

import { Hono } from "hono";
import type { Env } from "./env.js";
import { requireAccess, type AccessVariables } from "./middleware/require-access.js";
import { requireInternalToken } from "./middleware/require-internal-token.js";
import { problemDetailsErrorHandler } from "./middleware/error.js";
import { edgesRoute } from "./routes/edges.js";
import { marketRoute } from "./routes/market.js";
import { opsRoute } from "./routes/ops.js";
import { packsRoute } from "./routes/packs.js";
import { internalRoute } from "./routes/internal.js";

const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

app.onError(problemDetailsErrorHandler);

app.get("/api/v1/healthz", (c) => c.json({ ok: true, ts: Date.now() }));

app.use("/api/v1/*", requireAccess);
app.route("/api/v1/edges", edgesRoute);
app.route("/api/v1/market", marketRoute);
app.route("/api/v1/ops", opsRoute);
app.route("/api/v1/packs", packsRoute);

app.use("/internal/*", requireInternalToken);
app.route("/internal", internalRoute);

// SPA fallback for anything not matched above.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
