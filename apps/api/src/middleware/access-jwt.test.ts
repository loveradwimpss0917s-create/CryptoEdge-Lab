import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessAuthError, verifyAccessJwt } from "./access-jwt.js";

function base64Url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";

async function issueTestJwt(overrides: Partial<Record<string, unknown>> = {}) {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "test-kid";
  const header = { alg: "RS256", kid };
  const payload = {
    email: "researcher@example.com",
    aud: [AUD],
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: `https://${TEAM_DOMAIN}`,
    sub: "user-123",
    ...overrides
  };
  const headerB64 = base64Url(JSON.stringify(header));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, signingInput);
  const token = `${headerB64}.${payloadB64}.${base64Url(signature)}`;
  return { token, jwks: { keys: [{ ...jwk, kid, alg: "RS256" }] } };
}

describe("verifyAccessJwt (docs/01 §5)", () => {
  const originalCaches = (globalThis as unknown as { caches?: unknown }).caches;

  beforeEach(() => {
    // Minimal Cache API stand-in: always miss so each test hits the fetch mock.
    (globalThis as unknown as { caches: unknown }).caches = {
      default: {
        match: async () => undefined,
        put: async () => undefined
      }
    };
  });

  afterEach(() => {
    (globalThis as unknown as { caches: unknown }).caches = originalCaches;
    vi.unstubAllGlobals();
  });

  it("accepts a validly signed token matching aud/iss and not expired", async () => {
    const { token, jwks } = await issueTestJwt();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }))
    );
    const claims = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(claims.email).toBe("researcher@example.com");
  });

  it("rejects an expired token", async () => {
    const { token, jwks } = await issueTestJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }))
    );
    await expect(verifyAccessJwt(token, TEAM_DOMAIN, AUD)).rejects.toThrow(AccessAuthError);
  });

  it("rejects a token with the wrong audience", async () => {
    const { token, jwks } = await issueTestJwt({ aud: ["someone-elses-app"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }))
    );
    await expect(verifyAccessJwt(token, TEAM_DOMAIN, AUD)).rejects.toThrow(/audience/);
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const { token, jwks } = await issueTestJwt();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }))
    );
    const [header, , sig] = token.split(".");
    const tamperedPayload = base64Url(JSON.stringify({ email: "attacker@example.com" }));
    await expect(
      verifyAccessJwt(`${header}.${tamperedPayload}.${sig}`, TEAM_DOMAIN, AUD)
    ).rejects.toThrow(/signature/);
  });

  it("rejects when no JWK matches the token's kid", async () => {
    const { token } = await issueTestJwt();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }))
    );
    await expect(verifyAccessJwt(token, TEAM_DOMAIN, AUD)).rejects.toThrow(/no matching JWK/);
  });
});
