import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { OAuthErrorCode } from "./errors.js";

/*
 * Pure validation rules of the authorization server: no storage, no network.
 *
 * Specifications: OAuth 2.1 (code + PKCE S256 only, no implicit, no plain),
 * RFC 8252 (native apps: any port on loopback redirects), RFC 7591 (dynamic
 * client registration), RFC 8707 (resource indicators), RFC 9207 (iss) and the
 * Client ID Metadata Document flow of the MCP 2025-11-25 authorization spec.
 */

/** Size limits applied to untrusted input. */
export const LIMITS = Object.freeze({
  /** Maximum length of one redirect URI. */
  redirectUriLength: 2000,
  /** Maximum number of redirect URIs per client. */
  redirectUriCount: 10,
  /** Maximum client_name length (characters, after cleanup). */
  clientName: 80,
  /** Maximum `state` length. */
  state: 2048,
  /** Maximum length of a Client ID Metadata Document URL. */
  metadataDocumentUrl: 1000,
  /** Maximum size of a Client ID Metadata Document body (bytes). */
  metadataDocumentBytes: 64 * 1024,
  /** Maximum request body of the registration, token and revocation endpoints (bytes). */
  requestBody: 64 * 1024,
  /** Maximum length of a token, code or client ID accepted for lookup. */
  token: 200,
});

/* ------------------------------------------------------------------ */
/* PKCE (RFC 7636, S256 only)                                          */
/* ------------------------------------------------------------------ */

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is the unpadded base64url SHA-256 digest: exactly 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Is the value a well-formed S256 `code_challenge`? */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE.test(challenge);
}

/** Is the value a well-formed `code_verifier` (43 to 128 unreserved characters)? */
export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === "string" && VERIFIER.test(verifier);
}

/** `base64url(sha256(verifier))`, the S256 code challenge for a verifier. */
export function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Does the verifier match the stored S256 challenge? Constant-time comparison. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const a = Buffer.from(computeCodeChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Redirect URIs                                                       */
/* ------------------------------------------------------------------ */

/** Schemes that run code in a browser or open local resources: never accepted. */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "filesystem:", "view-source:", "ws:", "wss:", "ftp:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CUSTOM_SCHEME = /^[a-z][a-z0-9+.-]*:$/;

/** Kind of redirect URI: web (https), loopback (http on localhost) or a private app scheme. */
export type RedirectUriKind = "https" | "loopback" | "custom_scheme";

/**
 * Inspects a redirect URI. Accepted: https on any host; http only on a loopback
 * host (`localhost`, `127.0.0.1`, `[::1]`); private app schemes such as
 * `cursor://` or `com.example.app:/cb`. Rejected: dangerous schemes, fragments,
 * user info, whitespace, control characters, more than 2000 characters.
 *
 * @returns The kind and parsed URL, or `null` when the URI is not acceptable.
 */
export function inspectRedirectUri(uri: unknown): { kind: RedirectUriKind; url: URL } | null {
  if (typeof uri !== "string" || !uri || uri.length > LIMITS.redirectUriLength) return null;
  // The URL parser silently drops tabs and newlines; reject them so exact matching stays exact.
  if (/[\s\p{Cc}]/u.test(uri) || uri.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const scheme = url.protocol.toLowerCase();
  if (FORBIDDEN_SCHEMES.has(scheme)) return null;
  if (scheme === "https:") return url.hostname ? { kind: "https", url } : null;
  if (scheme === "http:") return LOOPBACK_HOSTS.has(url.hostname) ? { kind: "loopback", url } : null;
  if (!CUSTOM_SCHEME.test(scheme)) return null;
  return { kind: "custom_scheme", url };
}

/** Is the value an acceptable redirect URI? See {@link inspectRedirectUri}. */
export function isValidRedirectUri(uri: unknown): uri is string {
  return inspectRedirectUri(uri) !== null;
}

/** Validates a `redirect_uris` array: 1 to 10 acceptable URIs, duplicates removed. */
export function validateRedirectUris(list: unknown): { uris: string[] } | { error: string } {
  if (!Array.isArray(list) || list.length === 0) return { error: "redirect_uris is required" };
  if (list.length > LIMITS.redirectUriCount) return { error: `at most ${LIMITS.redirectUriCount} redirect_uris are allowed` };
  const unique: string[] = [];
  for (const uri of list) {
    if (!isValidRedirectUri(uri)) {
      return { error: "redirect_uris must use https, http on a loopback address, or a private app scheme, without a fragment" };
    }
    if (!unique.includes(uri)) unique.push(uri);
  }
  return { uris: unique };
}

/**
 * Does the requested redirect URI match a registered one? Exact string
 * comparison, except that loopback http URIs may use any port (RFC 8252 §7.3):
 * scheme, host, path and query must still be identical.
 */
export function matchRedirectUri(registered: readonly string[], requested: string): boolean {
  const req = inspectRedirectUri(requested);
  if (!req) return false;
  if (registered.includes(requested)) return true;
  if (req.kind !== "loopback") return false;
  return registered.some((r) => {
    const reg = inspectRedirectUri(r);
    return reg?.kind === "loopback" && reg.url.hostname === req.url.hostname && reg.url.pathname === req.url.pathname && reg.url.search === req.url.search;
  });
}

/** Adds query parameters to a redirect URI, keeping its existing query; empty values are skipped. */
export function buildRedirectUrl(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * What the consent screen should show as the destination: the host name for
 * https and loopback URIs, `scheme://` for app schemes. `null` when invalid.
 */
export function describeRedirectUri(uri: string): { kind: RedirectUriKind; display: string } | null {
  const i = inspectRedirectUri(uri);
  if (!i) return null;
  if (i.kind === "custom_scheme") return { kind: i.kind, display: `${i.url.protocol}//` };
  return { kind: i.kind, display: i.url.hostname };
}

/* ------------------------------------------------------------------ */
/* Scopes                                                              */
/* ------------------------------------------------------------------ */

/** RFC 6749 §3.3 scope-token: printable ASCII without space, `"` and `\`. */
export const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/**
 * Parses a `scope` parameter against the known scopes. Unknown scopes are
 * dropped; the result follows the order of `known` without duplicates. When no
 * known scope remains (missing, empty or only unknown), `fallback` is returned.
 */
export function parseScope(scope: unknown, known: readonly string[], fallback: readonly string[]): string[] {
  if (typeof scope !== "string") return [...fallback];
  const requested = new Set(scope.split(/\s+/).filter(Boolean));
  const result = known.filter((k) => requested.has(k));
  return result.length ? result : [...fallback];
}

/* ------------------------------------------------------------------ */
/* Client metadata                                                     */
/* ------------------------------------------------------------------ */

/**
 * Cleans a display name: control and format characters (direction overrides,
 * zero-width spaces, used for name spoofing) become spaces, whitespace is
 * collapsed, the result is capped at `max` characters. `null` when empty.
 */
export function sanitizeClientName(name: unknown, max: number = LIMITS.clientName): string | null {
  if (typeof name !== "string") return null;
  const clean = name
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : clean;
}

/** `client_uri` / `logo_uri`: https only, at most 2000 characters, no user info. Otherwise `null`. */
export function sanitizeHttpsUrl(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length > 2000 || /[\s\p{Cc}]/u.test(uri)) return null;
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && u.hostname && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Display name for a client without a name: the host (or scheme) of its first redirect URI. */
export function fallbackClientName(redirectUris: readonly string[]): string {
  const d = redirectUris[0] ? describeRedirectUri(redirectUris[0]) : null;
  return d ? d.display.replace(/:\/\/$/, "") : "OAuth client";
}

/** Supported client authentication methods at the token and revocation endpoints. */
export const CLIENT_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
/** A supported client authentication method. */
export type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number];

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];

/** Normalized result of a valid dynamic registration request. */
export interface RegistrationInfo {
  name: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  clientUri: string | null;
  logoUri: string | null;
  softwareId: string | null;
  softwareVersion: string | null;
  /** `software_id` and `software_version` joined, for display. */
  software: string | null;
  grantTypes: string[];
  /** Requested scope, normalized against the known scopes; `null` when not sent. */
  scope: string | null;
}

/**
 * Validates and normalizes a dynamic client registration request (RFC 7591).
 * Unsupported grant types are dropped (authorization_code must remain);
 * `response_types`, when present, must include `code`.
 */
export function validateRegistration(
  body: unknown,
  knownScopes: readonly string[],
  defaultScopes: readonly string[],
): { ok: true; info: RegistrationInfo } | { ok: false; code: OAuthErrorCode; description: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "invalid_client_metadata", description: "Request body must be a JSON object." };
  }
  const g = body as Record<string, unknown>;
  const list = validateRedirectUris(g.redirect_uris);
  if ("error" in list) return { ok: false, code: "invalid_redirect_uri", description: list.error };

  const method = g.token_endpoint_auth_method ?? "none";
  if (typeof method !== "string" || !(CLIENT_AUTH_METHODS as readonly string[]).includes(method)) {
    return { ok: false, code: "invalid_client_metadata", description: "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic." };
  }

  let grantTypes = [...SUPPORTED_GRANT_TYPES];
  if (g.grant_types !== undefined) {
    if (!Array.isArray(g.grant_types)) return { ok: false, code: "invalid_client_metadata", description: "grant_types must be an array." };
    const requested = g.grant_types.filter((t): t is string => typeof t === "string" && SUPPORTED_GRANT_TYPES.includes(t));
    if (!requested.includes("authorization_code")) {
      return { ok: false, code: "invalid_client_metadata", description: "grant_types must include authorization_code." };
    }
    grantTypes = SUPPORTED_GRANT_TYPES.filter((t) => requested.includes(t));
  }
  if (g.response_types !== undefined && (!Array.isArray(g.response_types) || !g.response_types.includes("code"))) {
    return { ok: false, code: "invalid_client_metadata", description: "response_types must include code." };
  }

  const softwareId = sanitizeClientName(g.software_id);
  const softwareVersion = sanitizeClientName(g.software_version, 40);
  return {
    ok: true,
    info: {
      name: sanitizeClientName(g.client_name) ?? fallbackClientName(list.uris),
      redirectUris: list.uris,
      authMethod: method as ClientAuthMethod,
      clientUri: sanitizeHttpsUrl(g.client_uri),
      logoUri: sanitizeHttpsUrl(g.logo_uri),
      softwareId,
      softwareVersion,
      software: [softwareId, softwareVersion].filter(Boolean).join(" ") || null,
      grantTypes,
      scope: typeof g.scope === "string" ? parseScope(g.scope, knownScopes, defaultScopes).join(" ") : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Client ID Metadata Document                                         */
/* ------------------------------------------------------------------ */

/**
 * Is the client ID a Client ID Metadata Document URL? It must be https on the
 * default port, with a path other than `/`, no fragment, no user info, no dot
 * segments, and written in canonical form (equal to its parsed `href`).
 */
export function isClientMetadataDocumentUrl(id: unknown): id is string {
  if (typeof id !== "string" || id.length > LIMITS.metadataDocumentUrl || !id.startsWith("https://")) return false;
  if (/[\s\p{Cc}#]/u.test(id) || /\/(\.|%2e){1,2}(\/|\?|$)/i.test(id)) return false;
  let u: URL;
  try {
    u = new URL(id);
  } catch {
    return false;
  }
  if (u.href !== id || u.username || u.password || u.port || !u.hostname) return false;
  return u.pathname.length > 1;
}

/** Normalized content of a valid Client ID Metadata Document. */
export interface ClientMetadataDocument {
  name: string;
  redirectUris: string[];
  clientUri: string | null;
  logoUri: string | null;
  software: string | null;
}

/**
 * Validates a fetched Client ID Metadata Document: its `client_id` must equal the
 * URL it was fetched from and its redirect URIs must be acceptable. Such clients
 * cannot hold a shared secret, so only `token_endpoint_auth_method: none` is allowed.
 */
export function validateClientMetadataDocument(doc: unknown, url: string): ClientMetadataDocument | { error: string } {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: "document is not a JSON object" };
  const b = doc as Record<string, unknown>;
  if (b.client_id !== url) return { error: "client_id does not match the document URL" };
  if (b.client_secret !== undefined || b.client_secret_expires_at !== undefined) return { error: "document must not contain a client secret" };
  if ((b.token_endpoint_auth_method ?? "none") !== "none") return { error: "only token_endpoint_auth_method none is supported" };
  if (b.grant_types !== undefined && (!Array.isArray(b.grant_types) || !b.grant_types.includes("authorization_code"))) {
    return { error: "grant_types must include authorization_code" };
  }
  if (b.response_types !== undefined && (!Array.isArray(b.response_types) || !b.response_types.includes("code"))) {
    return { error: "response_types must include code" };
  }
  const list = validateRedirectUris(b.redirect_uris);
  if ("error" in list) return { error: list.error };
  const softwareId = sanitizeClientName(b.software_id);
  const softwareVersion = sanitizeClientName(b.software_version, 40);
  return {
    name: sanitizeClientName(b.client_name) ?? new URL(url).hostname,
    redirectUris: list.uris,
    clientUri: sanitizeHttpsUrl(b.client_uri),
    logoUri: sanitizeHttpsUrl(b.logo_uri),
    software: [softwareId, softwareVersion].filter(Boolean).join(" ") || null,
  };
}

/* ------------------------------------------------------------------ */
/* Resource indicator (RFC 8707)                                       */
/* ------------------------------------------------------------------ */

function normalizedResource(value: string): string | null {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Is the `resource` parameter one of the accepted resource URLs? Trailing slashes
 * are ignored; query, fragment and user info are rejected.
 */
export function isAcceptedResource(resource: unknown, accepted: readonly string[]): resource is string {
  if (typeof resource !== "string" || !resource || resource.length > 2000 || resource.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search) return false;
  const value = normalizedResource(resource);
  return value !== null && accepted.some((a) => normalizedResource(a) === value);
}

/* ------------------------------------------------------------------ */
/* Consent token                                                       */
/* ------------------------------------------------------------------ */

/**
 * The signed authorization request carried by the consent form. It binds the
 * user, client, redirect URI, PKCE challenge, scopes, state, resource, issuer and
 * creation time, so the form can only send this token and a decision.
 */
export interface ConsentPayload {
  /** User ID. */
  u: string;
  /** client_id */
  c: string;
  /** redirect_uri */
  r: string;
  /** S256 code_challenge */
  ch: string;
  /** Granted scopes, space separated. */
  s: string;
  /** state */
  st: string | null;
  /** resource (RFC 8707) */
  rs: string | null;
  /** Issuer the token was minted for. */
  i: string;
  /** Creation time (ms since epoch). */
  t: number;
}

function sign(data: string, secret: string | Uint8Array): string {
  return createHmac("sha256", secret).update(`mcp-oauth-consent:${data}`).digest("base64url");
}

/** Signs a consent payload: `base64url(json).hmac`. */
export function signConsentToken(payload: ConsentPayload, secret: string | Uint8Array): string {
  const data = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${data}.${sign(data, secret)}`;
}

/** Verifies the signature and shape of a consent token (not its age). `null` when invalid. */
export function verifyConsentToken(token: unknown, secret: string | Uint8Array): ConsentPayload | null {
  if (typeof token !== "string" || token.length > 12_000) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || token.indexOf(".", dot + 1) !== -1) return null;
  const data = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(data, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as Partial<ConsentPayload>;
    const text = (x: unknown) => typeof x === "string" && x.length > 0;
    if (!text(p.u) || !text(p.c) || !text(p.r) || !text(p.ch) || !text(p.i) || typeof p.s !== "string" || typeof p.t !== "number") return null;
    if (p.st !== null && typeof p.st !== "string") return null;
    if (p.rs !== null && typeof p.rs !== "string") return null;
    return p as ConsentPayload;
  } catch {
    return null;
  }
}

/** Is the consent token younger than `ttlMs` (and not more than one minute in the future)? */
export function isConsentFresh(payload: ConsentPayload, nowMs: number, ttlMs: number): boolean {
  return payload.t <= nowMs + 60_000 && nowMs - payload.t <= ttlMs;
}

/** Rebuilds the authorization query from a consent payload (to restart an expired consent). */
export function authorizationQueryFromConsent(p: Pick<ConsentPayload, "c" | "r" | "ch" | "s" | "st" | "rs">): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.c,
    redirect_uri: p.r,
    code_challenge: p.ch,
    code_challenge_method: "S256",
    scope: p.s,
  });
  if (p.st) q.set("state", p.st);
  if (p.rs) q.set("resource", p.rs);
  return q.toString();
}
