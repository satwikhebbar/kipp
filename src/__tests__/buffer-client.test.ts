import { afterEach, expect, it, vi } from "vitest"
import {
  type BufferChannel,
  createBufferPostOnce,
  decodeBufferPost,
  discoverBuffer,
  validateSubstackChannel,
} from "../integrations/buffer/client"
import { bufferRedirectUri, parseBufferToken } from "../integrations/buffer/oauth"
import { mapSubstackPost } from "../integrations/buffer/substack"
import type { BufferCreateCommand } from "../notes/types"
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

const command: BufferCreateCommand = {
  destination: {
    accountId: "account",
    connectionId: "connection",
    organizationId: "org-one",
    channelId: "substack-one",
    service: "substack",
  },
  text: "Exact Note",
  attachmentUrl: null,
  timing: { kind: "now" },
}
const acceptedPost = {
  id: "post",
  channelId: "substack-one",
  channelService: "substack",
  text: "Exact Note",
  status: "sent",
  shareMode: "shareNow",
  schedulingType: null,
  isCustomScheduled: false,
  sharedNow: true,
  externalLink: null,
  metadata: { linkAttachment: null },
}

it("maps text-only immediate approval exactly and accepts a nullable scheduling type without a public link", async () => {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    Response.json({ data: { createPost: { __typename: "PostActionSuccess", post: acceptedPost } } }),
  )
  vi.stubGlobal("fetch", fetch)
  expect(await createBufferPostOnce("synthetic", command)).toEqual({ kind: "accepted", postId: "post" })
  expect(fetch).toHaveBeenCalledTimes(1)
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
  expect(body.variables.input).toEqual({
    channelId: "substack-one",
    text: "Exact Note",
    assets: [],
    mode: "shareNow",
    schedulingType: "automatic",
    needsApproval: false,
    saveToDraft: false,
  })
  expect(body.query).toContain("shareMode")
  expect(body.query).toContain("SubstackPostMetadata")
})

it.each([
  { status: "draft" },
  { status: "needsApproval" },
  { channelId: "other" },
  { text: "altered" },
  { shareMode: "addToQueue" },
  { schedulingType: "notification" },
  { sharedNow: false },
  { metadata: { linkAttachment: { url: "https://unapproved.example" } } },
])("preserves unexpected-created evidence for %j", (patch) => {
  expect(decodeBufferPost({ ...acceptedPost, ...patch }, command)).toMatchObject({
    kind: "created-unexpected",
    postId: "post",
  })
})

it.each([
  "UnauthorizedError",
  "InvalidInputError",
  "NotFoundError",
  "LimitReachedError",
])("does not treat generic %s as proof of no create", async (typename) => {
  const fetch = vi.fn(async () =>
    Response.json({ data: { createPost: { __typename: typename, message: "private provider prose" } } }),
  )
  vi.stubGlobal("fetch", fetch)
  expect(await createBufferPostOnce("synthetic", command)).toEqual({ kind: "unknown", reason: "unconfirmed-create" })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(["http", "malformed", "network"])("makes no hidden retry after %s failure", async (failure) => {
  const fetch = vi.fn(async () => {
    if (failure === "network") throw new Error("network interrupted")
    return new Response(failure === "malformed" ? "invalid" : "{}", { status: failure === "http" ? 503 : 200 })
  })
  vi.stubGlobal("fetch", fetch)
  expect(await createBufferPostOnce("synthetic", command)).toMatchObject({ kind: "unknown" })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it("maps and verifies exactly the approved embedded card", async () => {
  const linked = { ...command, attachmentUrl: "https://example.com/a?q=1#b" }
  expect(mapSubstackPost(linked)).toMatchObject({
    metadata: { substack: { linkAttachment: { url: linked.attachmentUrl } } },
  })
  expect(
    decodeBufferPost(
      { ...acceptedPost, metadata: { linkAttachment: { url: linked.attachmentUrl, expandedUrl: "" } } },
      linked,
    ).kind,
  ).toBe("accepted")
  expect(decodeBufferPost(acceptedPost, linked).kind).toBe("created-unexpected")
  expect(
    decodeBufferPost({ ...acceptedPost, metadata: { linkAttachment: { url: "https://different.com" } } }, linked).kind,
  ).toBe("created-unexpected")
})
