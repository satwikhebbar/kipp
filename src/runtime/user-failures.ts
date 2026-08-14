import { GithubError } from "../integrations/github"
import { HTTP_STATUS } from "./http"

/** Maps an error to safe, fixed user-facing wording; never forwards message bodies, values, or credentials. */
export function userFacingFailureMessage(err: unknown): string {
  if (err instanceof GithubError) {
    if (err.status === HTTP_STATUS.UNAUTHORIZED || err.status === HTTP_STATUS.FORBIDDEN)
      return `⚠️ Storage access was denied (HTTP ${err.status}). A credential may be expired or revoked — check the integration token and try again.`
    return `⚠️ A storage request failed (HTTP ${err.status}). Please try again shortly.`
  }
  return "⚠️ Something went wrong. Please try again shortly."
}
