import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generates a prefixed random token: `prefix` followed by `length` base62
 * characters (43 characters is about 256 bits). Rejection sampling keeps the
 * distribution uniform.
 */
export function generateToken(prefix: string, length = 43): string {
  let body = "";
  while (body.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) body += ALPHABET[b % 62];
      if (body.length === length) break;
    }
  }
  return prefix + body;
}

/**
 * Storage hash of a token, code or client secret: hex SHA-256. Tokens carry
 * 256 bits of randomness, so an unsalted hash is sufficient; only this hash is
 * ever persisted.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Compares two strings in constant time (with respect to their content). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Extracts the token from an `Authorization: Bearer <token>` header, or `null`. */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}
