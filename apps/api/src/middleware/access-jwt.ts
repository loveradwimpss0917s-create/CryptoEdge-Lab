// Cloudflare Access (Zero Trust Free) JWT verification (docs/01 §5). Access
// sits in front of this Worker and attaches a signed JWT in the
// `Cf-Access-Jwt-Assertion` header; we verify it ourselves rather than
// trusting the header blindly, since Workers are reachable directly by
// their workers.dev URL unless a route rule blocks it.
//
// No external JWT library: RS256 verification is a handful of WebCrypto
// calls, and pulling in a dependency for this is not worth it for a
// single-tenant Worker.

export interface AccessClaims {
  email: string;
  aud: string[] | string;
  exp: number;
  iss: string;
  sub: string;
}

export class AccessAuthError extends Error {}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input))) as T;
}

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: Jwk[];
}

const JWKS_CACHE_TTL_SECONDS = 3600;

async function fetchJwks(teamDomain: string): Promise<JwksResponse> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const cache = caches.default;
  const cacheKey = new Request(url);
  const cached = await cache.match(cacheKey);
  if (cached) return (await cached.json()) as JwksResponse;

  const res = await fetch(url);
  if (!res.ok) throw new AccessAuthError(`failed to fetch Access JWKS: HTTP ${res.status}`);
  const body = (await res.json()) as JwksResponse;
  const cacheable = new Response(JSON.stringify(body), {
    headers: { "cache-control": `max-age=${JWKS_CACHE_TTL_SECONDS}`, "content-type": "application/json" }
  });
  await cache.put(cacheKey, cacheable);
  return body;
}

async function importVerifyKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/**
 * Verifies a Cloudflare Access JWT and returns its claims. Throws
 * AccessAuthError on any failure — callers should treat that as 401/403.
 */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string
): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessAuthError("malformed JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = base64UrlToJson<{ kid: string; alg: string }>(headerB64);
  if (header.alg !== "RS256") throw new AccessAuthError(`unsupported alg: ${header.alg}`);

  const jwks = await fetchJwks(teamDomain);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessAuthError("no matching JWK for kid");

  const key = await importVerifyKey(jwk);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(sigB64);
  const valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signedData);
  if (!valid) throw new AccessAuthError("signature verification failed");

  const claims = base64UrlToJson<AccessClaims>(payloadB64);
  if (claims.exp * 1000 < Date.now()) throw new AccessAuthError("token expired");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedAud)) throw new AccessAuthError("audience mismatch");
  if (claims.iss !== `https://${teamDomain}`) throw new AccessAuthError("issuer mismatch");

  return claims;
}
