import { afterEach, expect, it, vi } from "vitest"
import { type BufferChannel, discoverBuffer, validateSubstackChannel } from "../integrations/buffer/client"
import { bufferRedirectUri, parseBufferToken } from "../integrations/buffer/oauth"
import { bufferHarness } from "./helpers/buffer-vault"

afterEach(() => vi.unstubAllGlobals())
const channel: BufferChannel = {
  id: "substack-one",
  organizationId: "org-one",
  name: "Author",
  service: "substack",
  allowedActions: ["scheduleUpdates"],
  isDisconnected: false,
  isLocked: false,
  isQueuePaused: false,
}
it("discovers only authenticated organizations and validates returned organization membership", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { account: { id: "account", organizations: [{ id: "org-one" }] } } }))
    .mockResolvedValueOnce(Response.json({ data: { channels: [channel] } }))
  vi.stubGlobal("fetch", fetch)
  expect(await discoverBuffer("access")).toEqual({ accountId: "account", channels: [channel] })
  expect(JSON.parse(fetch.mock.calls[1][1].body).variables).toEqual({ organizationId: "org-one" })
})
it.each([
  [undefined, {}, false, "Set BUFFER_SUBSTACK_CHANNEL_ID"],
  ["other", {}, false, "not available"],
  ["substack-one", { service: "linkedin" }, false, "Substack channel"],
  ["substack-one", { isDisconnected: true }, false, "Reconnect"],
  ["substack-one", { isLocked: true }, false, "does not permit"],
  ["substack-one", { allowedActions: [] }, false, "does not permit"],
  ["substack-one", { isQueuePaused: true }, true, "paused"],
  ["substack-one", {}, true, "ready"],
] as const)("validates channel %s %j", (id, overrides, ready, message) => {
  const result = validateSubstackChannel(
    {
      accountId: "account",
      channels: [
        {
          ...channel,
          ...overrides,
          allowedActions: "allowedActions" in overrides ? [...overrides.allowedActions] : channel.allowedActions,
        },
      ],
    },
    id,
  )
  expect(result.ready).toBe(ready)
  expect(result.message).toContain(message)
})
it("rejects cross-organization channel data and API GraphQL errors", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { account: { id: "account", organizations: [{ id: "other" }] } } }))
    .mockResolvedValueOnce(Response.json({ data: { channels: [channel] } }))
    .mockResolvedValueOnce(Response.json({ errors: [{ message: "sensitive upstream value" }] }))
  vi.stubGlobal("fetch", fetch)
  await expect(discoverBuffer("access")).rejects.toThrow("Invalid Buffer channel")
  await expect(discoverBuffer("access")).rejects.toThrow("Buffer account discovery failed")
})
it("requires HTTPS origin and rejects host/path/query injection", () => {
  const env = bufferHarness().env
  for (const origin of [
    "http://host",
    "https://user:pass@host",
    "https://host/path",
    "https://host?x=1",
    "https://host#x",
    "",
  ])
    expect(bufferRedirectUri({ ...env, BUFFER_REDIRECT_ORIGIN: origin })).toBeNull()
})
it("rejects incomplete token responses including missing scopes and invalid lifetime", () => {
  for (const response of [
    {},
    { access_token: "a", refresh_token: "r", expires_in: -1 },
    { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer", scope: "account:read" },
  ])
    expect(() => parseBufferToken(response)).toThrow("Incomplete Buffer authorization")
})
