import { describe, expect, it } from "vitest";
import type { R2Bucket, R2ObjectBody, R2Objects } from "@cloudflare/workers-types";
import { lakeRoute } from "./lake.js";
import type { Env } from "../env.js";

// Minimal in-memory R2 fake covering exactly what lake.ts calls: list()
// (with prefix/cursor pagination) and get() (with Range-header support).
class FakeR2 {
  private readonly objects = new Map<string, Uint8Array>();

  put(key: string, data: string): void {
    this.objects.set(key, new TextEncoder().encode(data));
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects> {
    const keys = [...this.objects.keys()].filter((k) => !options.prefix || k.startsWith(options.prefix)).sort();
    return {
      objects: keys.map((key) => ({
        key,
        size: this.objects.get(key)!.length,
        uploaded: new Date(0),
        etag: key,
        httpEtag: `"${key}"`,
        checksums: {},
        writeHttpMetadata: () => undefined
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
      truncated: false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  async get(key: string, options?: { range?: Headers }): Promise<R2ObjectBody | null> {
    const data = this.objects.get(key);
    if (!data) return null;

    let body = data;
    let range: { offset: number; length?: number } | undefined;
    const rangeHeader = options?.range?.get("range");
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] !== undefined ? Number(match[2]) : data.length - 1;
        body = data.slice(start, end + 1);
        range = { offset: start, length: end - start + 1 };
      }
    }

    return {
      key,
      size: data.length,
      etag: key,
      httpEtag: `"${key}"`,
      checksums: {},
      uploaded: new Date(0),
      range,
      writeHttpMetadata: () => undefined,
      body: new Response(body).body,
      text: async () => new TextDecoder().decode(body)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
}

function makeEnv(lake: FakeR2): Env {
  return { LAKE: lake as unknown as R2Bucket } as Env;
}

describe("GET /lake/catalog (docs/15 SONNET-8)", () => {
  it("lists objects under curated/ and features/", async () => {
    const lake = new FakeR2();
    lake.put("curated/market/candles_1m/BTCUSDT.BINANCE.PERP/data.parquet", "x".repeat(100));
    lake.put("features/v1/BTCUSDT.BINANCE.PERP/1h/data.parquet", "y".repeat(50));
    lake.put("raw/okx_rest/candles_1m/dt=2026-07-01/part-0.ndjson", "ignored");

    const res = await lakeRoute.request("/catalog", {}, makeEnv(lake));
    const body = (await res.json()) as { datasets: { key: string; size: number }[] };
    const keys = body.datasets.map((d) => d.key);
    expect(keys).toContain("curated/market/candles_1m/BTCUSDT.BINANCE.PERP/data.parquet");
    expect(keys).toContain("features/v1/BTCUSDT.BINANCE.PERP/1h/data.parquet");
    expect(keys).not.toContain("raw/okx_rest/candles_1m/dt=2026-07-01/part-0.ndjson");
  });
});

describe("GET /lake/* passthrough (docs/15 SONNET-8)", () => {
  it("rejects paths outside curated/features", async () => {
    const lake = new FakeR2();
    const res = await lakeRoute.request("/raw/okx_rest/foo.ndjson", {}, makeEnv(lake));
    expect(res.status).toBe(400);
  });

  it("404s for a missing key", async () => {
    const lake = new FakeR2();
    const res = await lakeRoute.request("/curated/market/nope/data.parquet", {}, makeEnv(lake));
    expect(res.status).toBe(404);
  });

  it("serves the whole object with immutable cache headers when no Range is given", async () => {
    const lake = new FakeR2();
    lake.put("curated/market/candles_1m/BTCUSDT.BINANCE.PERP/data.parquet", "hello parquet");
    const res = await lakeRoute.request("/curated/market/candles_1m/BTCUSDT.BINANCE.PERP/data.parquet", {}, makeEnv(lake));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello parquet");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("serves a 206 partial response honoring the Range header", async () => {
    const lake = new FakeR2();
    lake.put("curated/market/candles_1m/BTCUSDT.BINANCE.PERP/data.parquet", "0123456789");
    const res = await lakeRoute.request(
      "/curated/market/candles_1m/BTCUSDT.BINANCE.PERP/data.parquet",
      { headers: { range: "bytes=2-4" } },
      makeEnv(lake)
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("234");
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
  });
});
