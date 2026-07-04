// Test-only D1Database shim backed by Node's built-in `node:sqlite`
// (experimental, Node >=22). Real SQLite semantics (UPSERT, RETURNING,
// numbered `?1` parameters) let service-layer tests exercise actual SQL
// instead of a hand-rolled mock that could silently diverge from D1's
// behavior. Only the subset of the D1Database API this codebase uses is
// implemented.
//
// Mirrors apps/api/src/test-utils/fake-d1.ts exactly (same migrations
// directory depth from this package) -- duplicated rather than shared
// since the two packages aren't set up to import each other's test-utils.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface D1LikeResult<T = unknown> {
  results: T[];
  success: boolean;
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

  async run(): Promise<D1LikeResult> {
    const stmt = this.db.prepare(this.sql);
    stmt.run(...(this.params as never[]));
    return { results: [], success: true };
  }

  async all<T>(): Promise<D1LikeResult<T>> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...(this.params as never[])) as T[];
    return { results, success: true };
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
    return Promise.all(statements.map((stmt) => stmt.run()));
  }

  close(): void {
    this.db.close();
  }
}
