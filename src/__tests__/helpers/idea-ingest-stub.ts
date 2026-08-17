import { vi } from "vitest"

export interface FakeIdeaIngestStub {
  stub: {
    idFromName: (name: string) => { name: string }
    get: (id: { name: string }) => { fetch: ReturnType<typeof vi.fn> }
  }
  ingestFetches: Map<string, ReturnType<typeof vi.fn>>
}

/** Lazy Durable Object stub matching the ingest:<key>/claim:<pageId> naming contract. */
export function createFakeIdeaIngestStub(payload: Record<string, unknown>): FakeIdeaIngestStub {
  const ingestFetches = new Map<string, ReturnType<typeof vi.fn>>()
  const stub = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => {
      let fetchMock = ingestFetches.get(id.name)
      if (!fetchMock) {
        fetchMock = vi.fn().mockResolvedValue(Response.json(payload))
        ingestFetches.set(id.name, fetchMock)
      }
      return { fetch: fetchMock }
    },
  }
  return { stub, ingestFetches }
}
