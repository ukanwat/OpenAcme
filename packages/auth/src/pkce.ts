import * as crypto from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random 32-byte verifier, base64url-encoded (RFC 7636). */
export function generateVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

/** SHA-256(verifier), base64url-encoded — the S256 challenge. */
export function generateChallenge(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

/** Random opaque state for CSRF protection. */
export function generateState(): string {
  return base64url(crypto.randomBytes(32));
}
