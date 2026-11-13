import { DatabaseSync } from "node:sqlite"
import { InteractionRouterDO } from "../../core/interaction-router"
import type { Env } from "../../core/types"

/** Exercises the real Durable Object SQL with one isolated SQLite database per chat. */
export function sqliteInteractionRouter(env: Env = {} as Env) {
  const objects = new Map<string, InteractionRouterDO>()
  const databases = new Map<string, DatabaseSync>()
  const registrations: Array<Record<string, unknown>> = []
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (url: string | Request, init?: RequestInit) => {
        let router = objects.get(id)
        if (!router) {
          const db = databases.get(id) ?? new DatabaseSync(":memory:")
          databases.set(id, db)
          const sql = {
            exec: (query: string, ...args: Array<string | number | null>) => {
              const statement = db.prepare(query)
              if (statement.columns().length) return { toArray: () => statement.all(...args) }
              statement.run(...args)
              return { toArray: () => [] }
            },
          }
          router = new InteractionRouterDO(
            {
              storage: {
                sql,
                transactionSync: (fn: () => unknown) => {
                  db.exec("BEGIN")
                  try {
                    const result = fn()
                    db.exec("COMMIT")
                    return result
                  } catch (error) {
                    db.exec("ROLLBACK")
                    throw error
                  }
                },
              },
            } as never,
            env,
          )
          objects.set(id, router)
        }
        const request = new Request(url, init)
        if (new URL(request.url).pathname === "/register")
          registrations.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
        return router.fetch(request)
      },
    }),
  } as unknown as DurableObjectNamespace
  return { namespace, registrations, evict: (chatId: string) => objects.delete(chatId) }
}
