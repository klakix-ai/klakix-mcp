import { OAuthError, type OAuthErrorCode } from "./errors.js";
import { BodyTooLargeError, errorResponse, jsonResponse, parseBasicAuth, preflightResponse, readLimitedText, readOAuthParams, CORS_HEADERS, NO_STORE_HEADERS } from "./http.js";
import {
  authorizationQueryFromConsent,
  buildRedirectUrl,
  CLIENT_AUTH_METHODS,
  describeRedirectUri,
  isAcceptedResource,
  isClientMetadataDocumentUrl,
  isConsentFresh,
  isValidCodeChallenge,
  isValidCodeVerifier,
  LIMITS,
  matchRedirectUri,
  parseScope,
  SCOPE_TOKEN,
  signConsentToken,
  validateClientMetadataDocument,
  validateRegistration,
  verifyConsentToken,
  verifyPkce,
  type ConsentPayload,
  type RedirectUriKind,
} from "./rules.js";
import { fetchJsonSafely, type DnsLookup, type FetchLike } from "./ssrf.js";
import type { ClientRecord, CleanupResult, GrantRecord, OAuthStore } from "./store.js";
import { extractBearerToken, generateToken, hashToken, timingSafeEqualString } from "./tokens.js";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** A scope offered by the MCP server, with the text shown on the consent screen. */
export interface ScopeDefinition {
  name: string;
  description: string;
}

/** Prefixes of generated credentials. They make leaked tokens easy to recognize in secret scanners. */
export interface TokenPrefixes {
  accessToken: string;
  refreshToken: string;
  authorizationCode: string;
  clientId: string;
  clientSecret: string;
}

/** Default credential prefixes. */
export const DEFAULT_TOKEN_PREFIXES: Readonly<TokenPrefixes> = Object.freeze({
  accessToken: "mcp_at_",
  refreshToken: "mcp_rt_",
  authorizationCode: "mcp_ac_",
  clientId: "mcp_ci_",
  clientSecret: "mcp_cs_",
});

/** Endpoint locations. Values are absolute URLs or paths appended to the issuer. */
export interface EndpointOptions {
  /** Consent page of the application. Default `/oauth/authorize`. */
  authorization?: string;
  /** Default `/oauth/token`. */
  token?: string;
  /** Default `/oauth/register`. */
  registration?: string;
  /** Default `/oauth/revoke`. */
  revocation?: string;
}

/** Options of {@link createOAuthServer}. */
export interface OAuthServerOptions {
  /** Issuer URL (RFC 8414): the origin, optionally with a path. Sent as `iss` in redirects. */
  issuer: string;
  /** URL of the protected MCP endpoint (RFC 8707 / RFC 9728 `resource`). */
  resource: string;
  /** Scopes offered to clients, in display order. At least one. */
  scopes: ScopeDefinition[];
  /** Scopes granted when a client asks for none of the known ones. Default: all scopes. */
  defaultScopes?: string[];
  /** Persistence. */
  store: OAuthStore;
  /** HMAC key for consent tokens, at least 32 bytes. Keep it secret and stable across instances. */
  secret: string | Uint8Array;
  /** Credential prefixes; see {@link DEFAULT_TOKEN_PREFIXES}. */
  tokenPrefixes?: Partial<TokenPrefixes>;
  /** Access token lifetime in seconds. Default 3600 (1 hour). */
  accessTokenTtl?: number;
  /** Refresh token lifetime in seconds. Default 5184000 (60 days). */
  refreshTokenTtl?: number;
  /** Authorization code lifetime in seconds. Default 600 (10 minutes). */
  authorizationCodeTtl?: number;
  /** Consent token lifetime in seconds. Default 900 (15 minutes). */
  consentTtl?: number;
  /** Endpoint locations. */
  endpoints?: EndpointOptions;
  /**
   * Extra values accepted for the `resource` parameter. The `resource` option and
   * the issuer's origin are always accepted.
   */
  acceptedResources?: string[];
  /** `resource_name` in the protected resource metadata. */
  resourceName?: string;
  /** `resource_documentation` in the protected resource metadata. */
  resourceDocumentation?: string;
  /** `service_documentation` in the authorization server metadata. */
  serviceDocumentation?: string;
  /** Enable dynamic client registration (RFC 7591). Default `true`. */
  dynamicClientRegistration?: boolean;
  /** Accept HTTPS URLs as client IDs (Client ID Metadata Documents). Default `true`. */
  clientIdMetadataDocuments?: boolean;
  /**
   * Custom fetch for metadata documents. By default a built-in `node:https` client
   * is used, which pins the connection to the address that passed the public-IP check.
   */
  fetch?: FetchLike;
  /** Host name resolver for metadata documents. Default: `dns.promises.lookup`. */
  dnsLookup?: DnsLookup;
  /**
   * Called before each dynamic registration; return `false` to refuse it with
   * 429 `temporarily_unavailable` (use it for per-IP rate limiting).
   */
  allowRegistration?: (request: Request) => boolean | Promise<boolean>;
  /**
   * Called on approval, code exchange, refresh and access token verification;
   * return `false` for suspended or deleted users.
   */
  isUserAllowed?: (userId: string) => boolean | Promise<boolean>;
  /** Receives unexpected errors raised inside endpoint handlers. Default: `console.error`. */
  onError?: (error: unknown) => void;
  /** Clock in milliseconds. Default `Date.now`. */
  now?: () => number;
}

/** Successful token endpoint response (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Client details for the consent screen. */
export interface ClientInfo {
  id: string;
  name: string;
  clientUri: string | null;
  logoUri: string | null;
  software: string | null;
  registrationType: ClientRecord["registrationType"];
}

/** Query parameters of the authorization request. */
export type AuthorizeParams = URLSearchParams | Record<string, string | string[] | undefined>;

/** Result of {@link OAuthServer.authorize.parse}. */
export type AuthorizeParseResult =
  | {
      ok: true;
      client: ClientInfo;
      redirectUri: string;
      /** What to show as the destination: host name, or `scheme://` for app schemes. */
      redirect: { kind: RedirectUriKind; display: string };
      /** Scopes that will be granted, with their descriptions. */
      scopes: ScopeDefinition[];
      state: string | null;
      resource: string | null;
      /**
       * Signed request to put in the consent form. `null` when `parse` was called
       * without a user ID (validate first, then sign the user in, then parse again).
       */
      consentToken: string | null;
    }
  | {
      ok: false;
      /** The client or redirect URI cannot be trusted: show an error page, never redirect. */
      type: "error_page";
      reason: "missing_parameters" | "unknown_client" | "invalid_redirect_uri";
      description: string;
    }
  | {
      ok: false;
      /** The redirect URI is verified but the request is invalid: send the user to `redirectTo`. */
      type: "redirect";
      error: Extract<OAuthErrorCode, "invalid_request" | "unsupported_response_type" | "invalid_target">;
      errorDescription: string;
      redirectTo: string;
    };

/** Result of {@link OAuthServer.authorize.approve} and {@link OAuthServer.authorize.deny}. */
export type ConsentDecisionResult =
  | { ok: true; redirectTo: string }
  | {
      ok: false;
      reason: "invalid_token" | "expired" | "user_mismatch" | "invalid_client" | "user_not_allowed";
      /**
       * Authorization query rebuilt from the token, to show the consent screen
       * again (`<authorization endpoint>?<authorizationQuery>`). Absent when the
       * token itself is invalid.
       */
      authorizationQuery?: string;
    };

/** Identity behind a valid access token. */
export interface AccessTokenInfo {
  userId: string;
  clientId: string;
  scopes: string[];
  grantId: string;
  resource: string | null;
  /** Access token expiry (ms since epoch). */
  expiresAt: number;
}

/** A Web Fetch API request handler. */
export type FetchHandler = (request: Request) => Promise<Response>;

/** The object returned by {@link createOAuthServer}. */
export interface OAuthServer {
  /** RFC 8414 metadata endpoint (GET). */
  authorizationServerMetadata: FetchHandler;
  /** RFC 9728 metadata endpoint (GET). */
  protectedResourceMetadata: FetchHandler;
  /** RFC 7591 dynamic client registration endpoint (POST). */
  register: FetchHandler;
  /** Token endpoint (POST): `authorization_code` and `refresh_token` grants. */
  token: FetchHandler;
  /** RFC 7009 revocation endpoint (POST). */
  revoke: FetchHandler;
  /** Building blocks for the application's consent page. */
  authorize: {
    /**
     * Validates an authorization request. Call it when rendering the consent
     * page; pass the signed-in user's ID to receive a `consentToken`.
     */
    parse(params: AuthorizeParams, userId?: string): Promise<AuthorizeParseResult>;
    /** Approves a consent token for the signed-in user; returns where to redirect (303). */
    approve(consentToken: unknown, userId: string): Promise<ConsentDecisionResult>;
    /** Denies a consent token; returns where to redirect (303) with `error=access_denied`. */
    deny(consentToken: unknown): Promise<ConsentDecisionResult>;
  };
  /** Verifies an access token. `null` when unknown, expired, revoked or the user is not allowed. */
  verifyAccessToken(token: unknown): Promise<AccessTokenInfo | null>;
  /** Verifies the `Authorization: Bearer` header of a request. */
  authenticate(request: Request): Promise<AccessTokenInfo | null>;
  /** `WWW-Authenticate` header value for a 401/403 from the MCP endpoint (RFC 6750, RFC 9728). */
  wwwAuthenticate(error?: "invalid_token" | "insufficient_scope" | "invalid_request", scope?: string): string;
  /** Revokes a grant (for a "connected apps" page). */
  revokeGrant(grantId: string): Promise<void>;
  /** Removes expired codes, ended grants and abandoned dynamic clients. Run it periodically. */
  cleanup(): Promise<CleanupResult>;
  /** Resolved endpoint URLs. */
  readonly endpoints: Readonly<Required<EndpointOptions>>;
  /** URL of the protected resource metadata, as used in `WWW-Authenticate`. */
  readonly resourceMetadataUrl: string;
  /** Request paths at which to mount the metadata handlers. */
  readonly wellKnownPaths: Readonly<{ authorizationServer: readonly string[]; protectedResource: readonly string[] }>;
}

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60_000;
const METADATA_CACHE_MS = 60 * 60_000;
const METADATA_ERROR_CACHE_MS = 60_000;
const METADATA_CACHE_LIMIT = 1000;
/** Used codes are kept this long after expiry so a replay still revokes the grant. */
const CODE_RETENTION_MS = DAY_MS;
const GRANT_RETENTION_MS = 30 * DAY_MS;
const CLIENT_RETENTION_MS = 7 * DAY_MS;
const PREFIX = /^[A-Za-z0-9_-]{1,32}$/;

function normalizeBaseUrl(value: string, name: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new TypeError(`${name} must use https (http is allowed only on localhost)`);
  if (u.search || u.hash || u.username || u.password) throw new TypeError(`${name} must not contain a query, fragment or credentials`);
  return u;
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function positiveSeconds(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer (seconds)`);
  return value;
}

/** Grant ID derived from the code: a replayed code can find and revoke the grant it produced. */
function grantIdForCode(codeHash: string): string {
  return `grant_${hashToken(`mcp-oauth-grant:${codeHash}`).slice(0, 40)}`;
}

function single(params: AuthorizeParams, name: string): string | null | undefined {
  if (params instanceof URLSearchParams) {
    const all = params.getAll(name);
    if (all.length === 0) return undefined;
    return all.length === 1 ? (all[0] ?? null) : null;
  }
  const v = params[name];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : null;
}

function clientInfo(c: ClientRecord): ClientInfo {
  return { id: c.id, name: c.name, clientUri: c.clientUri, logoUri: c.logoUri, software: c.software, registrationType: c.registrationType };
}

/**
 * Creates an OAuth 2.1 authorization server for a remote MCP server.
 *
 * Only the authorization code grant with PKCE S256 is supported. Access and
 * refresh tokens are opaque random strings stored as SHA-256 hashes; refresh
 * tokens rotate on every use and a replayed one revokes the whole grant.
 *
 * @throws TypeError when the options are invalid.
 */
export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
  const issuerUrl = normalizeBaseUrl(options.issuer, "issuer");
  const issuer = stripSlash(issuerUrl.href);
  const resourceUrl = normalizeBaseUrl(options.resource, "resource");
  const resource = resourceUrl.pathname === "/" ? resourceUrl.origin : resourceUrl.href;
  const store = options.store;
  if (!store) throw new TypeError("store is required");
  const now = options.now ?? Date.now;

  const secretLength = typeof options.secret === "string" ? Buffer.byteLength(options.secret) : options.secret?.byteLength ?? 0;
  if (secretLength < 32) throw new TypeError("secret must be at least 32 bytes");
  const secret = options.secret;

  if (!Array.isArray(options.scopes) || options.scopes.length === 0) throw new TypeError("at least one scope is required");
  const scopeNames: string[] = [];
  for (const s of options.scopes) {
    if (!s || typeof s.name !== "string" || !SCOPE_TOKEN.test(s.name)) throw new TypeError(`invalid scope name: ${String(s?.name)}`);
    if (scopeNames.includes(s.name)) throw new TypeError(`duplicate scope: ${s.name}`);
    scopeNames.push(s.name);
  }
  const scopeDefs = new Map(options.scopes.map((s) => [s.name, { name: s.name, description: String(s.description ?? "") }]));
  const defaultScopes = options.defaultScopes ?? scopeNames;
  if (!defaultScopes.length || defaultScopes.some((s) => !scopeDefs.has(s))) throw new TypeError("defaultScopes must be a non-empty subset of scopes");
  const fallbackScopes = scopeNames.filter((s) => defaultScopes.includes(s));

  const prefixes: TokenPrefixes = { ...DEFAULT_TOKEN_PREFIXES, ...options.tokenPrefixes };
  const prefixValues = Object.values(prefixes);
  if (prefixValues.some((p) => !PREFIX.test(p))) throw new TypeError("token prefixes must be 1-32 characters of A-Z, a-z, 0-9, _ and -");
  if (prefixValues.some((p, i) => prefixValues.some((q, j) => i !== j && (p.startsWith(q) || q.startsWith(p))))) {
    throw new TypeError("token prefixes must be distinct and must not be prefixes of each other");
  }

  const accessTtl = positiveSeconds(options.accessTokenTtl, 3600, "accessTokenTtl");
  const refreshTtl = positiveSeconds(options.refreshTokenTtl, 60 * 24 * 3600, "refreshTokenTtl");
  const codeTtl = positiveSeconds(options.authorizationCodeTtl, 600, "authorizationCodeTtl");
  const consentTtlMs = positiveSeconds(options.consentTtl, 900, "consentTtl") * 1000;

  const dcrEnabled = options.dynamicClientRegistration ?? true;
  const cimdEnabled = options.clientIdMetadataDocuments ?? true;
  const onError = options.onError ?? ((err: unknown) => console.error("[mcp-oauth]", err));

  const resolveEndpoint = (value: string | undefined, fallback: string): string => {
    const v = value ?? fallback;
    if (/^https?:\/\//i.test(v)) return v;
    if (!v.startsWith("/")) throw new TypeError(`endpoint paths must start with /: ${v}`);
    return `${issuer}${v}`;
  };
  const endpoints: Required<EndpointOptions> = Object.freeze({
    authorization: resolveEndpoint(options.endpoints?.authorization, "/oauth/authorize"),
    token: resolveEndpoint(options.endpoints?.token, "/oauth/token"),
    registration: resolveEndpoint(options.endpoints?.registration, "/oauth/register"),
    revocation: resolveEndpoint(options.endpoints?.revocation, "/oauth/revoke"),
  });

  const acceptedResources = [resource, issuerUrl.origin, ...(options.acceptedResources ?? [])];
  const resourcePath = stripSlash(resourceUrl.pathname);
  const issuerPath = stripSlash(issuerUrl.pathname);
  const resourceMetadataUrl = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourcePath}`;
  const unique = (xs: string[]) => [...new Set(xs)];
  const wellKnownPaths = Object.freeze({
    authorizationServer: Object.freeze(
      unique([
        `/.well-known/oauth-authorization-server${issuerPath}`,
        `/.well-known/openid-configuration${issuerPath}`,
        // Some clients append the resource path instead of the issuer path.
        `/.well-known/oauth-authorization-server${resourcePath}`,
      ]),
    ),
    protectedResource: Object.freeze(unique([`/.well-known/oauth-protected-resource${resourcePath}`, "/.well-known/oauth-protected-resource"])),
  });

  /* ---------------- metadata ---------------- */

  const authorizationServerMetadataBody = () => ({
    issuer,
    authorization_endpoint: endpoints.authorization,
    token_endpoint: endpoints.token,
    ...(dcrEnabled && { registration_endpoint: endpoints.registration }),
    revocation_endpoint: endpoints.revocation,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    scopes_supported: [...scopeNames],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: cimdEnabled,
    ...(options.serviceDocumentation && { service_documentation: options.serviceDocumentation }),
  });

  const protectedResourceMetadataBody = () => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...scopeNames],
    bearer_methods_supported: ["header"],
    ...(options.resourceName && { resource_name: options.resourceName }),
    ...(options.resourceDocumentation && { resource_documentation: options.resourceDocumentation }),
  });

  /* ---------------- endpoint wrapper ---------------- */

  const endpoint =
    (methods: string[], fn: FetchHandler): FetchHandler =>
    async (request) => {
      const method = request.method.toUpperCase();
      if (method === "OPTIONS") return preflightResponse();
      if (!methods.includes(method)) {
        return jsonResponse({ error: "invalid_request", error_description: "Method not allowed." }, 405, { Allow: [...methods, "OPTIONS"].join(", ") });
      }
      try {
        return await fn(request);
      } catch (err) {
        if (err instanceof OAuthError) return errorResponse(err);
        try {
          onError(err);
        } catch {
          /* a failing logger must not change the response */
        }
        return jsonResponse({ error: "server_error" }, 500);
      }
    };

  /* ---------------- clients ---------------- */

  const metadataCache = new Map<string, { at: number; ok: boolean }>();

  async function resolveMetadataClient(url: string): Promise<ClientRecord | null> {
    const t = now();
    const previous = metadataCache.get(url);
    if (previous && t - previous.at < (previous.ok ? METADATA_CACHE_MS : METADATA_ERROR_CACHE_MS)) {
      if (!previous.ok) return null;
      const stored = await store.getClient(url);
      if (stored) return stored;
    }
    let doc: ReturnType<typeof validateClientMetadataDocument> | null = null;
    try {
      doc = validateClientMetadataDocument(
        await fetchJsonSafely(url, { fetch: options.fetch, lookup: options.dnsLookup, maxBytes: LIMITS.metadataDocumentBytes, timeoutMs: 5000 }),
        url,
      );
    } catch {
      doc = null;
    }
    if (doc && "error" in doc) doc = null;
    if (metadataCache.size >= METADATA_CACHE_LIMIT) metadataCache.clear();
    metadataCache.set(url, { at: t, ok: Boolean(doc) });
    if (!doc) return null;

    const existing = await store.getClient(url);
    const record: ClientRecord = {
      id: url,
      registrationType: "metadata_document",
      name: doc.name,
      redirectUris: doc.redirectUris,
      authMethod: "none",
      secretHash: null,
      clientUri: doc.clientUri,
      logoUri: doc.logoUri,
      software: doc.software,
      grantTypes: ["authorization_code", "refresh_token"],
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
    };
    await store.saveClient(record);
    return record;
  }

  /**
   * client_id → client. Generated IDs are read from the store. A metadata document
   * URL is fetched (with a one-hour cache) only when `fetchDocument` is set: on the
   * consent page. Token and revocation requests use the stored copy only.
   */
  async function resolveClient(id: string, fetchDocument = false): Promise<ClientRecord | null> {
    if (id.startsWith(prefixes.clientId)) return id.length <= 100 ? store.getClient(id) : null;
    if (!cimdEnabled || !isClientMetadataDocumentUrl(id)) return null;
    if (fetchDocument) return resolveMetadataClient(id);
    const c = await store.getClient(id);
    return c?.registrationType === "metadata_document" ? c : null;
  }

  interface ClientAuth {
    client: ClientRecord | null;
    /** Did the client prove its identity with a secret? */
    authenticated: boolean;
  }

  /**
   * Client authentication: Basic header (client_secret_basic) or body
   * (client_secret_post), never both. Confidential clients must send their
   * secret; public clients send only client_id.
   */
  async function authenticateClient(request: Request, params: Record<string, string>, required: boolean): Promise<ClientAuth> {
    const basic = parseBasicAuth(request.headers.get("authorization"));
    const fail = (description: string) => new OAuthError("invalid_client", description, 401, basic ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {});
    if (basic === "malformed") throw fail("Malformed Basic authorization header.");
    if (basic && params.client_secret !== undefined) throw new OAuthError("invalid_request", "Use only one client authentication method.");
    if (basic && params.client_id !== undefined && params.client_id !== basic.clientId) throw fail("client_id does not match the authorization header.");

    const id = basic?.clientId ?? params.client_id ?? null;
    if (!id) {
      if (required) throw new OAuthError("invalid_client", "client_id is required.", 401);
      return { client: null, authenticated: false };
    }
    const client = id.length <= LIMITS.metadataDocumentUrl ? await resolveClient(id) : null;
    if (!client) throw fail("Unknown client.");
    if (client.authMethod === "none") return { client, authenticated: false };
    const presented = basic?.clientSecret ?? params.client_secret ?? null;
    if (!presented || !client.secretHash || !timingSafeEqualString(hashToken(presented), client.secretHash)) throw fail("Client authentication failed.");
    return { client, authenticated: true };
  }

  const userAllowed = async (userId: string) => (options.isUserAllowed ? Boolean(await options.isUserAllowed(userId)) : true);

  function issueTokens(t: number) {
    const accessToken = generateToken(prefixes.accessToken);
    const refreshToken = generateToken(prefixes.refreshToken);
    return {
      accessToken,
      refreshToken,
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      accessTokenExpiresAt: t + accessTtl * 1000,
      refreshTokenExpiresAt: t + refreshTtl * 1000,
    };
  }

  const tokenResponse = (accessToken: string, refreshToken: string, scopes: string[]): TokenResponse => ({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessTtl,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });

  /* ---------------- grants ---------------- */

  /**
   * grant_type=authorization_code. The code is checked against client, redirect
   * URI, expiry and PKCE, then spent with an atomic compare-and-set. A code that
   * comes back after being spent revokes the grant it produced (RFC 6749 §4.1.2).
   */
  async function exchangeCode(client: ClientRecord, params: Record<string, string>): Promise<TokenResponse> {
    const { code, redirect_uri: redirectUri, code_verifier: verifier, resource: requestedResource } = params;
    if (!code || code.length > LIMITS.token) throw new OAuthError("invalid_request", "code is required.");
    if (!redirectUri) throw new OAuthError("invalid_request", "redirect_uri is required.");
    if (!verifier) throw new OAuthError("invalid_request", "code_verifier is required.");
    if (!isValidCodeVerifier(verifier)) throw new OAuthError("invalid_grant", "code_verifier is malformed.");
    if (requestedResource !== undefined && !isAcceptedResource(requestedResource, acceptedResources)) throw new OAuthError("invalid_target", "Unknown resource.");

    const invalid = () =>
      new OAuthError("invalid_grant", "The authorization code is invalid, expired, already used, or does not match this client, redirect_uri or code_verifier.");
    const codeHash = hashToken(code);
    const t = now();
    const record = await store.getAuthorizationCode(codeHash);
    if (!record) throw invalid();
    if (record.usedAt !== null) {
      await store.revokeGrant(grantIdForCode(codeHash), t);
      throw invalid();
    }
    if (record.expiresAt <= t || record.clientId !== client.id || record.redirectUri !== redirectUri || !verifyPkce(verifier, record.codeChallenge)) {
      throw invalid();
    }
    if (!(await store.markAuthorizationCodeUsed(codeHash, t))) {
      // Lost a race against another exchange of the same code: treat it as a replay.
      await store.revokeGrant(grantIdForCode(codeHash), t);
      throw invalid();
    }
    if (!(await userAllowed(record.userId))) throw new OAuthError("invalid_grant", "This account cannot be connected.");

    const tokens = issueTokens(t);
    const grant: GrantRecord = {
      id: grantIdForCode(codeHash),
      userId: record.userId,
      clientId: record.clientId,
      scopes: record.scopes,
      resource: record.resource ?? requestedResource ?? null,
      accessTokenHash: tokens.accessTokenHash,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenHash: tokens.refreshTokenHash,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      previousRefreshTokenHash: null,
      revokedAt: null,
      createdAt: t,
      updatedAt: t,
    };
    await store.createGrant(grant);
    return tokenResponse(tokens.accessToken, tokens.refreshToken, record.scopes);
  }

  /**
   * grant_type=refresh_token. The refresh token rotates on every use; the rotated
   * token coming back revokes the grant. Scope cannot be widened.
   */
  async function refresh(auth: ClientAuth, params: Record<string, string>): Promise<TokenResponse> {
    const presented = params.refresh_token;
    if (!presented) throw new OAuthError("invalid_request", "refresh_token is required.");
    const invalid = () => new OAuthError("invalid_grant", "The refresh token is invalid, expired or revoked.");
    if (!presented.startsWith(prefixes.refreshToken) || presented.length > LIMITS.token) throw invalid();

    const hash = hashToken(presented);
    const t = now();
    const grant = await store.findGrantByRefreshTokenHash(hash);
    if (!grant) {
      const rotated = await store.findGrantByPreviousRefreshTokenHash(hash);
      if (rotated && rotated.revokedAt === null) await store.revokeGrant(rotated.id, t);
      throw invalid();
    }
    if (grant.revokedAt !== null || grant.refreshTokenExpiresAt <= t) throw invalid();

    // The token is bound to its client; a confidential client must authenticate.
    if (auth.client && auth.client.id !== grant.clientId) throw invalid();
    if (!auth.authenticated) {
      const client = auth.client ?? (await store.getClient(grant.clientId));
      if (!client) throw invalid();
      if (client.authMethod !== "none") throw new OAuthError("invalid_client", "Client authentication is required.", 401);
    }

    if (params.scope !== undefined && params.scope.trim()) {
      const requested = params.scope.split(/\s+/).filter(Boolean);
      if (requested.some((s) => !grant.scopes.includes(s))) throw new OAuthError("invalid_scope", "The requested scope exceeds the granted scope.");
    }
    if (!(await userAllowed(grant.userId))) throw new OAuthError("invalid_grant", "This account cannot be connected.");

    const tokens = issueTokens(t);
    const rotatedOk = await store.rotateGrantTokens(grant.id, hash, {
      accessTokenHash: tokens.accessTokenHash,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenHash: tokens.refreshTokenHash,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      previousRefreshTokenHash: hash,
      updatedAt: t,
    });
    // A concurrent request with the same token won the race: refuse this one, keep the grant
    // (a later replay is caught by the previous-token check above).
    if (!rotatedOk) throw invalid();
    return tokenResponse(tokens.accessToken, tokens.refreshToken, grant.scopes);
  }

  /** RFC 7009: an access or refresh token revokes its whole grant. Unknown tokens are ignored. */
  async function revokeToken(token: string, auth: ClientAuth): Promise<void> {
    if (token.length > LIMITS.token) return;
    const hash = hashToken(token);
    const grant = token.startsWith(prefixes.refreshToken)
      ? await store.findGrantByRefreshTokenHash(hash)
      : token.startsWith(prefixes.accessToken)
        ? await store.findGrantByAccessTokenHash(hash)
        : null;
    if (!grant) return;
    if (auth.client && auth.client.id !== grant.clientId) return;
    if (!auth.authenticated) {
      const client = auth.client ?? (await store.getClient(grant.clientId));
      if (client && client.authMethod !== "none") throw new OAuthError("invalid_client", "Client authentication is required.", 401);
    }
    await store.revokeGrant(grant.id, now());
  }

  /* ---------------- handlers ---------------- */

  const authorizationServerMetadata = endpoint(["GET", "HEAD"], async () => jsonResponse(authorizationServerMetadataBody()));
  const protectedResourceMetadata = endpoint(["GET", "HEAD"], async () => jsonResponse(protectedResourceMetadataBody()));

  const register = endpoint(["POST"], async (request) => {
    if (!dcrEnabled) throw new OAuthError("invalid_request", "Dynamic client registration is disabled.", 404);
    let text: string;
    try {
      text = await readLimitedText(request.body, LIMITS.requestBody, request.headers.get("content-length"));
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw new OAuthError("invalid_client_metadata", "Request body is too large.", 413);
      throw new OAuthError("invalid_client_metadata", "Request body could not be read.");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "Request body must be a JSON object.");
    }
    const result = validateRegistration(body, scopeNames, fallbackScopes);
    if (!result.ok) throw new OAuthError(result.code, result.description);
    if (options.allowRegistration && !(await options.allowRegistration(request))) {
      throw new OAuthError("temporarily_unavailable", "Too many client registrations. Try again later.", 429, { "Retry-After": "3600" });
    }
    const info = result.info;
    const t = now();
    const clientId = generateToken(prefixes.clientId);
    const clientSecret = info.authMethod === "none" ? null : generateToken(prefixes.clientSecret);
    await store.saveClient({
      id: clientId,
      registrationType: "dynamic",
      name: info.name,
      redirectUris: info.redirectUris,
      authMethod: info.authMethod,
      secretHash: clientSecret ? hashToken(clientSecret) : null,
      clientUri: info.clientUri,
      logoUri: info.logoUri,
      software: info.software,
      grantTypes: info.grantTypes,
      createdAt: t,
      updatedAt: t,
    });
    return jsonResponse(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(t / 1000),
        ...(clientSecret && { client_secret: clientSecret, client_secret_expires_at: 0 }),
        client_name: info.name,
        redirect_uris: info.redirectUris,
        grant_types: info.grantTypes,
        response_types: ["code"],
        token_endpoint_auth_method: info.authMethod,
        ...(info.scope && { scope: info.scope }),
        ...(info.clientUri && { client_uri: info.clientUri }),
        ...(info.logoUri && { logo_uri: info.logoUri }),
        ...(info.softwareId && { software_id: info.softwareId }),
        ...(info.softwareVersion && { software_version: info.softwareVersion }),
      },
      201,
    );
  });

  const token = endpoint(["POST"], async (request) => {
    const params = await readOAuthParams(request, LIMITS.requestBody);
    const grantType = params.grant_type;
    if (!grantType) throw new OAuthError("invalid_request", "grant_type is required.");
    if (grantType === "authorization_code") {
      const { client } = await authenticateClient(request, params, true);
      if (!client) throw new OAuthError("invalid_client", "client_id is required.", 401);
      return jsonResponse(await exchangeCode(client, params));
    }
    if (grantType === "refresh_token") {
      const auth = await authenticateClient(request, params, false);
      return jsonResponse(await refresh(auth, params));
    }
    throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  });

  const revoke = endpoint(["POST"], async (request) => {
    const params = await readOAuthParams(request, LIMITS.requestBody);
    if (!params.token) throw new OAuthError("invalid_request", "token is required.");
    const auth = await authenticateClient(request, params, false);
    await revokeToken(params.token, auth);
    return new Response(null, { status: 200, headers: { ...CORS_HEADERS, ...NO_STORE_HEADERS } });
  });

  /* ---------------- consent ---------------- */

  async function parse(params: AuthorizeParams, userId?: string): Promise<AuthorizeParseResult> {
    const clientId = single(params, "client_id");
    const redirectUri = single(params, "redirect_uri");
    if (!clientId || !redirectUri) {
      return { ok: false, type: "error_page", reason: "missing_parameters", description: "client_id and redirect_uri are required." };
    }
    // Client and redirect URI first: nothing is redirected anywhere until both are trusted.
    const client = clientId.length <= LIMITS.metadataDocumentUrl ? await resolveClient(clientId, true) : null;
    if (!client) return { ok: false, type: "error_page", reason: "unknown_client", description: "The client is unknown or its metadata could not be loaded." };
    if (!matchRedirectUri(client.redirectUris, redirectUri)) {
      return { ok: false, type: "error_page", reason: "invalid_redirect_uri", description: "redirect_uri is not registered for this client." };
    }

    const rawState = single(params, "state");
    const state = typeof rawState === "string" && rawState ? rawState : null;
    const fail = (error: Extract<OAuthErrorCode, "invalid_request" | "unsupported_response_type" | "invalid_target">, description: string): AuthorizeParseResult => ({
      ok: false,
      type: "redirect",
      error,
      errorDescription: description,
      redirectTo: buildRedirectUrl(redirectUri, {
        error,
        error_description: description,
        state: state && state.length <= LIMITS.state ? state : null,
        iss: issuer,
      }),
    });

    if (rawState === null || (state && state.length > LIMITS.state)) return fail("invalid_request", "state is invalid.");
    if (single(params, "response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (single(params, "code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    const challenge = single(params, "code_challenge");
    if (!isValidCodeChallenge(challenge)) return fail("invalid_request", "code_challenge is missing or malformed.");
    const rawResource = single(params, "resource");
    if (rawResource === null || (rawResource !== undefined && !isAcceptedResource(rawResource, acceptedResources))) {
      return fail("invalid_target", "The resource parameter must point to this MCP server.");
    }
    const scope = single(params, "scope");
    if (scope === null) return fail("invalid_request", "scope is invalid.");

    const scopes = parseScope(scope, scopeNames, fallbackScopes);
    const display = describeRedirectUri(redirectUri);
    return {
      ok: true,
      client: clientInfo(client),
      redirectUri,
      redirect: display ?? { kind: "https", display: redirectUri },
      scopes: scopes.map((s) => scopeDefs.get(s) ?? { name: s, description: "" }),
      state,
      resource: rawResource ?? null,
      consentToken: userId
        ? signConsentToken({ u: userId, c: client.id, r: redirectUri, ch: challenge, s: scopes.join(" "), st: state, rs: rawResource ?? null, i: issuer, t: now() }, secret)
        : null,
    };
  }

  /** Shared checks of approve and deny. */
  async function checkConsent(
    consentToken: unknown,
  ): Promise<{ error: ConsentDecisionResult } | { payload: ConsentPayload; client: ClientRecord; authorizationQuery: string }> {
    const p = verifyConsentToken(consentToken, secret);
    if (!p || p.i !== issuer) return { error: { ok: false, reason: "invalid_token" } };
    const authorizationQuery = authorizationQueryFromConsent(p);
    if (!isConsentFresh(p, now(), consentTtlMs)) return { error: { ok: false, reason: "expired", authorizationQuery } };
    const client = await resolveClient(p.c);
    if (!client || !matchRedirectUri(client.redirectUris, p.r)) return { error: { ok: false, reason: "invalid_client", authorizationQuery } };
    return { payload: p, client, authorizationQuery };
  }

  async function approve(consentToken: unknown, userId: string): Promise<ConsentDecisionResult> {
    const checked = await checkConsent(consentToken);
    if ("error" in checked) return checked.error;
    const { payload: p, client, authorizationQuery } = checked;
    if (typeof userId !== "string" || !userId || p.u !== userId) return { ok: false, reason: "user_mismatch", authorizationQuery };
    if (!(await userAllowed(userId))) return { ok: false, reason: "user_not_allowed", authorizationQuery };

    const t = now();
    const code = generateToken(prefixes.authorizationCode);
    await store.saveAuthorizationCode({
      codeHash: hashToken(code),
      clientId: client.id,
      userId,
      redirectUri: p.r,
      codeChallenge: p.ch,
      scopes: parseScope(p.s, scopeNames, fallbackScopes),
      resource: p.rs,
      expiresAt: t + codeTtl * 1000,
      usedAt: null,
      createdAt: t,
    });
    return { ok: true, redirectTo: buildRedirectUrl(p.r, { code, state: p.st, iss: issuer }) };
  }

  async function deny(consentToken: unknown): Promise<ConsentDecisionResult> {
    const checked = await checkConsent(consentToken);
    if ("error" in checked) return checked.error;
    return { ok: true, redirectTo: buildRedirectUrl(checked.payload.r, { error: "access_denied", state: checked.payload.st, iss: issuer }) };
  }

  /* ---------------- resource server side ---------------- */

  async function verifyAccessToken(value: unknown): Promise<AccessTokenInfo | null> {
    if (typeof value !== "string" || value.length > LIMITS.token || !value.startsWith(prefixes.accessToken)) return null;
    const grant = await store.findGrantByAccessTokenHash(hashToken(value));
    if (!grant || grant.revokedAt !== null || grant.accessTokenExpiresAt <= now()) return null;
    if (!(await userAllowed(grant.userId))) return null;
    return {
      userId: grant.userId,
      clientId: grant.clientId,
      scopes: [...grant.scopes],
      grantId: grant.id,
      resource: grant.resource,
      expiresAt: grant.accessTokenExpiresAt,
    };
  }

  function wwwAuthenticate(error?: "invalid_token" | "insufficient_scope" | "invalid_request", scope?: string): string {
    const parts = [`resource_metadata="${resourceMetadataUrl}"`];
    if (error) parts.push(`error="${error}"`);
    if (scope) {
      const clean = scope.split(/\s+/).filter((s) => SCOPE_TOKEN.test(s)).join(" ");
      if (clean) parts.push(`scope="${clean}"`);
    }
    return `Bearer ${parts.join(", ")}`;
  }

  async function cleanup(): Promise<CleanupResult> {
    const t = now();
    for (const [k, v] of metadataCache) if (t - v.at >= METADATA_CACHE_MS) metadataCache.delete(k);
    return store.deleteExpired({
      now: t,
      codesExpiredBefore: t - CODE_RETENTION_MS,
      grantsEndedBefore: t - GRANT_RETENTION_MS,
      unusedClientsCreatedBefore: t - CLIENT_RETENTION_MS,
    });
  }

  return {
    authorizationServerMetadata,
    protectedResourceMetadata,
    register,
    token,
    revoke,
    authorize: { parse, approve, deny },
    verifyAccessToken,
    authenticate: (request) => verifyAccessToken(extractBearerToken(request.headers.get("authorization"))),
    wwwAuthenticate,
    revokeGrant: (grantId) => store.revokeGrant(grantId, now()),
    cleanup,
    endpoints,
    resourceMetadataUrl,
    wellKnownPaths,
  };
}
