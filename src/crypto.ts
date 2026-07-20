export interface Envelope {
  v: number
  kid: string
  aad: string
  iv: string
  ct: string
}

export function base64urlEncode(buf: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/")
  while (str.length % 4) str += "="
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function encryptToken(
  plaintext: Record<string, unknown>,
  keyId: string,
  rawKey: ArrayBuffer,
  aadString = "kipp:linkedin-token:v1",
): Promise<Envelope> {
  if (rawKey.byteLength !== 32) throw new Error("invalid key length")
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = new TextEncoder().encode(aadString)
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(JSON.stringify(plaintext)),
  )
  return { v: 1, kid: keyId, aad: aadString, iv: base64urlEncode(iv), ct: base64urlEncode(new Uint8Array(ct)) }
}

export async function decryptToken(envelope: Envelope, rawKey: ArrayBuffer): Promise<Record<string, unknown> | null> {
  if (envelope.v !== 1) return null
  if (rawKey.byteLength !== 32) return null
  const aad = new TextEncoder().encode(envelope.aad)
  const iv = base64urlDecode(envelope.iv)
  if (iv.byteLength !== 12) return null
  const ct = base64urlDecode(envelope.ct)
  if (ct.byteLength < 16 || ct.byteLength > 10_048) return null
  try {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"])
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ct)
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>
  } catch {
    return null
  }
}
