import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

interface D1ResultLike {
  meta: { changes?: number }
  results?: Array<Record<string, unknown>>
}

/** A bound D1 statement carrying its SQL and parameters for batch execution. */
class D1BoundStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Array<string | number | null>,
    private readonly beforeExecute?: (sql: string) => void,
  ) {}

  run(): D1ResultLike {
    this.beforeExecute?.(this.sql)
    return executeD1(this.db, this.sql, this.params)
  }

  first(): Record<string, unknown> | null {
    this.beforeExecute?.(this.sql)
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined
    return row ?? null
  }

  all(): D1ResultLike {
    this.beforeExecute?.(this.sql)
    return executeD1(this.db, this.sql, this.params)
  }
}

function executeD1(db: DatabaseSync, sql: string, params: Array<string | number | null>): D1ResultLike {
  if (/^\s*SELECT/i.test(sql)) {
    const results = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return { meta: { changes: 0 }, results }
  }
  const info = db.prepare(sql).run(...params)
  return { meta: { changes: Number(info.changes) } }
}

/** Minimal D1Database adapter over `node:sqlite`; `batch` runs in one transaction. */
function createD1Adapter(db: DatabaseSync, beforeExecute?: (sql: string) => void): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: Array<string | number | null>) {
          return new D1BoundStatement(db, sql, params, beforeExecute)
        },
      }
    },
    batch(statements: D1BoundStatement[]) {
      db.exec("BEGIN")
      try {
        const results = statements.map((statement) => statement.run())
        db.exec("COMMIT")
        return results
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
  } as unknown as D1Database
}

/**
 * Creates an in-memory SQLite database with every ordered migration applied,
 * exposed through a D1-shaped adapter — so tests exercise the store's real SQL.
 */
export function createD1TestDb(
  throughMigration?: string,
  beforeExecute?: (sql: string) => void,
): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(":memory:")
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations")
  for (const migration of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql") && (!throughMigration || name <= throughMigration))
    .sort()) {
    db.exec(readFileSync(join(migrationsDir, migration), "utf8"))
  }
  return { db, d1: createD1Adapter(db, beforeExecute) }
}

/** Shares the workflow fixture clock with SQLite. Store tests use the real database clock by default. */
export function createClockedD1TestDb(
  now: () => string = () => new Date().toISOString(),
): ReturnType<typeof createD1TestDb> {
  const result = createD1TestDb()
  result.db.function("strftime", (format, value) => {
    if (format !== "%Y-%m-%dT%H:%M:%fZ" || value !== "now") throw new Error("Unsupported test clock query")
    return now()
  })
  return result
}

/** Counts rows for a `SELECT count(*) AS count ...` query. */
export function d1Count(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count)
}

/** Returns the first value of the first row of a scalar `SELECT ...` query. */
export function d1Scalar(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): unknown {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined
  return row ? Object.values(row)[0] : null
}
