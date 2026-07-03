import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccess, type AccessVariables } from "./require-access.js";

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();
  app.use("*", requireAccess);
  app.get("/", (c) => c.json({ ok: true }));
  app.post("/", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAccess (docs/10 review: fail-closed in production)", () => {
  it("allows GET unverified in production when Access isn't configured", async () => {
    const app = makeApp();
    const env = { ENVIRONMENT: "production" } as Env;
    const res = await app.request("/", { method: "GET" }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cryptoedge-auth")).toBe("unverified-dev-mode");
  });

  it("rejects POST with 401 in production when Access isn't configured", async () => {
    const app = makeApp();
    const env = { ENVIRONMENT: "production" } as Env;
    const res = await app.request("/", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("allows POST unverified outside production (local dev)", async () => {
    const app = makeApp();
    const env = {} as Env;
    const res = await app.request("/", { method: "POST" }, env);
    expect(res.status).toBe(200);
  });

  it("rejects a missing Access assertion with 401 when Access is configured, regardless of environment", async () => {
    const app = makeApp();
    const env = {
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag"
    } as Env;
    const res = await app.request("/", { method: "GET" }, env);
    expect(res.status).toBe(401);
  });
});
