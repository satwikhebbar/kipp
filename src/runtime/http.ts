export const HTTP_STATUS = {
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  SERVER_ERROR_START: 500,
} as const

export function isTransientServerError(status: number): boolean {
  return status >= HTTP_STATUS.SERVER_ERROR_START
}

export function isTransientHttpStatus(status: number): boolean {
  return status === HTTP_STATUS.TOO_MANY_REQUESTS || isTransientServerError(status)
}
