// Lake パススルー (docs/08 "Lake パススルー", docs/06 §1 item 6, docs/15
// SONNET-8): the only server-side role in Explorer is serving R2 bytes --
// all querying happens client-side in DuckDB-WASM (docs/01 §3.3, "サーバ
// 計算なしで返す"). Every object under `curated/`/`features/` is a single
// concrete Parquet file per dataset (no dt=-partitioned globs in the
// actual writers -- research/jobs/lake_sync.py and features_sync.py both
// write one stable key per dataset), so the catalog can list keys
// directly without needing to group partitions.

import { Hono } from "hono";
import type { Env } from "../env.js";

export const lakeRoute = new Hono<{ Bindings: Env }>();

interface CatalogEntry {
  key: string;
  size: number;
  uploaded: string;
}

lakeRoute.get("/catalog", async (c) => {
  const entries: CatalogEntry[] = [];
  for (const prefix of ["curated/", "features/"]) {
    let cursor: string | undefined;
    // Bounded to a few pages -- docs/13 §2.3 sizes the whole lake at
    // ~1.2GB/year of Parquet, nowhere near enough objects to need deep
    // pagination; this just guards against an unbounded loop if it ever did.
    // Sequential by design -- each page's cursor depends on the previous
    // page's response, so these awaits cannot run in parallel.
    /* eslint-disable no-await-in-loop */
    for (let page = 0; page < 20; page++) {
      const listing = await c.env.LAKE.list(cursor ? { prefix, cursor, limit: 1000 } : { prefix, limit: 1000 });
      for (const obj of listing.objects) {
        entries.push({ key: obj.key, size: obj.size, uploaded: obj.uploaded.toISOString() });
      }
      if (!listing.truncated) break;
      cursor = listing.cursor;
    }
    /* eslint-enable no-await-in-loop */
  }
  return c.json({ datasets: entries });
});

// DuckDB-WASM's httpfs issues a HEAD (to learn file size) followed by
// Range GETs (to read only the Parquet footer/row-groups it needs) --
// both must be supported for it to query multi-MB files without
// downloading them whole. R2's `range` option accepts a raw `Headers`
// object directly, so the incoming `Range` header is passed through
// as-is rather than hand-parsed.
lakeRoute.get("/*", async (c) => {
  // Strips the mount prefix when mounted under app.route("/api/v1/lake",
  // lakeRoute) in production, or just the leading "/" when this route is
  // exercised directly (e.g. in tests) -- either way, the R2 key itself
  // never starts with a slash.
  const key = c.req.path.replace(/^\/(api\/v1\/lake\/)?/, "");
  if (!key.startsWith("curated/") && !key.startsWith("features/")) {
    return c.json({ type: "about:blank", title: "path must be under curated/ or features/", status: 400 }, 400);
  }

  const hasRange = c.req.header("range") !== undefined;
  const object = await c.env.LAKE.get(key, hasRange ? { range: c.req.raw.headers } : undefined);
  if (!object) return c.json({ type: "about:blank", title: "not found", status: 404 }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");

  if (object.range) {
    const total = object.size;
    const offset = "suffix" in object.range ? total - object.range.suffix : (object.range.offset ?? 0);
    const length = "length" in object.range && object.range.length !== undefined ? object.range.length : total - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${total}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { status: 200, headers });
});
