export interface Envelope {
  v: number
  kid: string
  aad: string
  iv: string
  ct: string
}

export const AES_256_KEY_LENGTH = 32
export const AES_GCM_IV_LENGTH = 12
const AES_GCM_MIN_CT_LENGTH = 16
const AES_GCM_MAX_CT_LENGTH = 10_048
const BASE64_PADDING_ALIGNMENT = 4

/** Encodes a byte array as base64url (RFC 4648 §5, no padding). */
export function base64urlEncode(buf: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decodes a base64url string back to bytes. */
export function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/")
  while (str.length % BASE64_PADDING_ALIGNMENT) str += "="
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encrypts a JSON-serializable payload with AES-256-GCM and returns the envelope. */
export async function encryptToken(
  plaintext: Record<string, unknown>,
  keyId: string,
  rawKey: ArrayBuffer,
  aadString = "kipp:linkedin-token:v1",
): Promise<Envelope> {
  if (rawKey.byteLength !== AES_256_KEY_LENGTH) throw new Error("invalid key length")
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH))
  const aad = new TextEncoder().encode(aadString)
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(JSON.stringify(plaintext)),
  )
  return { v: 1, kid: keyId, aad: aadString, iv: base64urlEncode(iv), ct: base64urlEncode(new Uint8Array(ct)) }
}

/** Decrypts an AES-256-GCM envelope, returning null on any failure. */
export async function decryptToken(envelope: Envelope, rawKey: ArrayBuffer): Promise<Record<string, unknown> | null> {
  if (envelope.v !== 1) return null
  if (rawKey.byteLength !== AES_256_KEY_LENGTH) return null
  try {
    const aad = new TextEncoder().encode(envelope.aad)
    const iv = base64urlDecode(envelope.iv)
    if (iv.byteLength !== AES_GCM_IV_LENGTH) return null
    const ct = base64urlDecode(envelope.ct)
    if (ct.byteLength < AES_GCM_MIN_CT_LENGTH || ct.byteLength > AES_GCM_MAX_CT_LENGTH) return null
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"])
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ct)
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>
  } catch {
    return null
  }
}
