export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVER_ERROR_START: 500,
  SERVICE_UNAVAILABLE: 503,
} as const

export function isTransientServerError(status: number): boolean {
  return status >= HTTP_STATUS.SERVER_ERROR_START
}

export function isTransientHttpStatus(status: number): boolean {
  return status === HTTP_STATUS.TOO_MANY_REQUESTS || isTransientServerError(status)
}
