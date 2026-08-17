import { describe, expect, it } from "vitest"
import { GithubError } from "../integrations/github"
import { NotionError } from "../integrations/notion"
import { userFacingFailureMessage } from "../runtime/user-failures"

describe("userFacingFailureMessage", () => {
  it("maps GithubError 401 to storage-auth wording without leaking error body", () => {
    const message = userFacingFailureMessage(new GithubError(401, "GitHub read ideas.md error 401: SECRETBODY"))
    expect(message).toContain("Storage access was denied")
    expect(message).toContain("401")
    expect(message).not.toContain("SECRETBODY")
  })

  it("maps GithubError 403 to storage-auth wording", () => {
    const message = userFacingFailureMessage(new GithubError(403, "forbidden"))
    expect(message).toContain("Storage access was denied")
    expect(message).toContain("403")
  })

  it("maps other GithubError statuses to generic storage wording with the status", () => {
    const message = userFacingFailureMessage(new GithubError(500, "boom"))
    expect(message).toContain("storage request failed")
    expect(message).toContain("500")
  })

  it("maps NotionError 401 to storage-auth wording without leaking error body", () => {
    const message = userFacingFailureMessage(new NotionError(401, "Notion request failed (HTTP 401): SECRETBODY"))
    expect(message).toContain("Storage access was denied")
    expect(message).toContain("401")
    expect(message).not.toContain("SECRETBODY")
  })

  it("maps unknown errors to generic wording and never leaks message content", () => {
    const message = userFacingFailureMessage(new Error("secret token=abcdef payload"))
    expect(message).toContain("Something went wrong")
    expect(message).not.toContain("abcdef")
  })
})
