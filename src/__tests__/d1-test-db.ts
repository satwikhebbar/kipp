import { readFileSync } from "node:fs"
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
  ) {}

  run(): D1ResultLike {
    return executeD1(this.db, this.sql, this.params)
  }

  first(): Record<string, unknown> | null {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined
    return row ?? null
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
function createD1Adapter(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: Array<string | number | null>) {
          return new D1BoundStatement(db, sql, params)
        },
      }
    },
    batch(statements: D1BoundStatement[]) {
      db.exec("BEGIN")
      try {
        const results = statements.map((statement) => executeD1(db, statement.sql, statement.params))
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
export function createD1TestDb(): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(":memory:")
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations")
  for (const migration of ["0001_init.sql", "0002_mini_app_review.sql"]) {
    db.exec(readFileSync(join(migrationsDir, migration), "utf8"))
  }
  return { db, d1: createD1Adapter(db) }
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
