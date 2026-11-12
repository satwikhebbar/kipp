import { base64urlEncode } from "../../core/crypto"
import { TokenVaultDO } from "../../core/token-vault"
import type { BufferGrantInput, Env } from "../../core/types"
import { BUFFER_SCOPES } from "../../integrations/buffer/oauth"

export function bufferHarness() {
  const entries = new Map<string, unknown>()
  let alarm: number | null = null
  const storage = {
    get: async (key: string) => entries.get(key),
    put: async (key: string, value: unknown) => {
      entries.set(key, value)
    },
    delete: async (key: string) => entries.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...entries].filter(([key]) => key.startsWith(prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => {
      alarm = value
    },
  }
  const env = {
    TOKEN_ENCRYPTION_KEY_IDS: "test",
    TOKEN_ENCRYPTION_KEY_test: base64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    BUFFER_CLIENT_ID: "client",
    BUFFER_CLIENT_SECRET: "secret",
    BUFFER_REDIRECT_ORIGIN: "https://kipp.test",
    DEPLOYMENT_ENV: "development",
    ALLOW_INSECURE_LOCAL_TOKEN_FALLBACK: "true",
  } as unknown as Env
  const create = () => new TokenVaultDO({ storage } as never, env)
  let vault = create()
  const command = async <T = Record<string, unknown>>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await vault.fetch(
      new Request("https://vault.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, ...args }),
      }),
    )
    if (!response.ok) throw new Error(`vault status ${response.status}`)
    return response.json() as Promise<T>
  }
  env.TOKEN_VAULT = {
    idFromName: () => "singleton",
    get: () => ({ fetch: (url: string, init: RequestInit) => vault.fetch(new Request(url, init)) }),
  } as never
  return {
    env,
    storage,
    entries,
    command,
    restart: () => {
      vault = create()
    },
  }
}
export function grant(overrides: Partial<BufferGrantInput> = {}): BufferGrantInput {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    accountId: "account-one",
    expiresAtMs: Date.now() + 30_000,
    scopes: [...BUFFER_SCOPES],
    ...overrides,
  }
}
export function tokenResponse(overrides = {}) {
  return Response.json({
    access_token: "access-new",
    refresh_token: "refresh-new",
    expires_in: 3600,
    token_type: "Bearer",
    scope: BUFFER_SCOPES.join(" "),
    ...overrides,
  })
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
