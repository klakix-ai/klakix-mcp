import { OAuthError, oauthErrorBody } from "./errors.js";

/**
 * CORS headers for the metadata, registration, token and revocation endpoints.
 * Browser-based clients (for example MCP Inspector) call them directly; no
 * cookies are involved, so a wildcard origin is safe.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
});

/** Cache headers for token responses (RFC 6749 §5.1). */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  Pragma: "no-cache",
});

/** CORS preflight (OPTIONS) response. */
export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...NO_STORE_HEADERS } });
}

/** JSON response with CORS and no-store headers. */
export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

/** Turns an {@link OAuthError} into its RFC 6749 JSON response. */
export function errorResponse(error: OAuthError): Response {
  return jsonResponse(oauthErrorBody(error.code, error.description), error.status, error.headers);
}

/**
 * Reads a request body as UTF-8 text without buffering more than `maxBytes`.
 * Rejects early on a too-large `Content-Length` and stops reading the stream as
 * soon as the limit is crossed.
 */
export async function readLimitedText(body: ReadableStream<Uint8Array> | null, maxBytes: number, declaredLength?: string | null): Promise<string> {
  const declared = Number(declaredLength ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/** Thrown by {@link readLimitedText} when the body exceeds the limit. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body is too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a token or revocation request body: `application/x-www-form-urlencoded`
 * (default) or JSON. Only string values are kept (finite numbers are stringified).
 * A form parameter sent twice is rejected as `invalid_request` (RFC 6749 §3.2).
 */
export async function readOAuthParams(request: Request, maxBytes: number): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readLimitedText(request.body, maxBytes, request.headers.get("content-length"));
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new OAuthError("invalid_request", "Request body is too large.", 413);
    throw new OAuthError("invalid_request", "Request body could not be read.");
  }
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (type.includes("json")) {
    let data: unknown;
    try {
      data = JSON.parse(text || "{}");
    } catch {
      throw new OAuthError("invalid_request", "Request body is not valid JSON.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new OAuthError("invalid_request", "Request body must be a JSON object.");
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    }
    return out;
  }
  const params = new URLSearchParams(text);
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length > 1) throw new OAuthError("invalid_request", `Parameter ${key.slice(0, 40)} was sent more than once.`);
    out[key] = values[0] ?? "";
  }
  return out;
}

function formDecode(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, " "));
}

/**
 * Parses an `Authorization: Basic` header (client_secret_basic, RFC 6749 §2.3.1).
 * Returns `null` when there is no Basic header, `"malformed"` when the header is
 * Basic but cannot be decoded. The client ID and secret are form-urlencoded
 * before base64 encoding, so they are decoded here.
 */
export function parseBasicAuth(header: string | null | undefined): { clientId: string; clientSecret: string } | null | "malformed" {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=._~-]+)\s*$/i.exec(header);
  if (!m || !m[1]) return /^Basic\b/i.test(header) ? "malformed" : null;
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 1) return "malformed";
    const clientId = formDecode(decoded.slice(0, colon));
    const clientSecret = formDecode(decoded.slice(colon + 1));
    return clientId ? { clientId, clientSecret } : "malformed";
  } catch {
    return "malformed";
  }
}
