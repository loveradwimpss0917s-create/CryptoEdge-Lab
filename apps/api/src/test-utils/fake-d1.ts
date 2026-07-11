// Test-only D1Database shim backed by Node's built-in `node:sqlite`
// (experimental, Node >=22). Real SQLite semantics (UPSERT, RETURNING,
// numbered `?1` parameters) let service-layer tests exercise actual SQL
// instead of a hand-rolled mock that could silently diverge from D1's
// behavior. Only the subset of the D1Database API this codebase uses is
// implemented.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded via createRequire rather than a static `import` so Vitest's
// Vite-based transform never has to resolve the "node:sqlite" specifier
// (it isn't in Vite's built-in-module allowlist yet since the module is
// still experimental in Node). The type-only import above is erased at
// build time and never reaches that resolver.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface D1LikeResult<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes: number };
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSyncInstance,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  // `meta.changes` mirrors real D1's D1Result shape -- node:sqlite's own
  // `.run()` already returns `{changes, lastInsertRowid}` directly, so this
  // just re-shapes it rather than computing anything new. Without this,
  // any code following the common "written = changes > 0" pattern (already
  // used by touchIngestState's dq_issues auto-resolve and upsertEvent)
  // throws `Cannot read properties of undefined (reading 'changes')` the
  // moment a test actually inspects that return value against FakeD1
  // (found while adding POST /internal/events' write-count response).
  async run(): Promise<D1LikeResult> {
    const stmt = this.db.prepare(this.sql);
    const { changes } = stmt.run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(changes) } };
  }

  async all<T>(): Promise<D1LikeResult<T>> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...(this.params as never[])) as T[];
    return { results, success: true, meta: { changes: 0 } };
  }

  async first<T>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as never[]));
    return (row as T) ?? null;
  }
}

export class FakeD1 {
  private readonly db: DatabaseSyncInstance;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const dir = join(import.meta.dirname, "../../../../migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      this.db.exec(sql);
    }
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  async batch(statements: FakeStatement[]): Promise<D1LikeResult[]> {
    // Each statement's `run()` is synchronous under the hood (node:sqlite has
    // no real I/O wait), so Promise.all here is just interface compatibility
    // with D1Database.batch(), not real concurrency.
    return Promise.all(statements.map((stmt) => stmt.run()));
  }

  close(): void {
    this.db.close();
  }
}
