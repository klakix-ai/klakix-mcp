/**
 * OAuth 2.1 authorization server for remote MCP servers.
 *
 * Storage-agnostic and dependency-free: bring an {@link OAuthStore}
 * implementation, mount the Web Fetch API handlers returned by
 * {@link createOAuthServer}, and render your own consent page.
 *
 * @packageDocumentation
 */

export {
  createOAuthServer,
  DEFAULT_TOKEN_PREFIXES,
  type AccessTokenInfo,
  type AuthorizeParams,
  type AuthorizeParseResult,
  type ClientInfo,
  type ConsentDecisionResult,
  type EndpointOptions,
  type FetchHandler,
  type OAuthServer,
  type OAuthServerOptions,
  type ScopeDefinition,
  type TokenPrefixes,
  type TokenResponse,
} from "./server.js";

export {
  MemoryStore,
  type AuthorizationCodeRecord,
  type CleanupCutoffs,
  type CleanupResult,
  type ClientRecord,
  type GrantRecord,
  type GrantTokenUpdate,
  type OAuthStore,
} from "./store.js";

export { OAuthError, oauthErrorBody, sanitizeErrorDescription, type OAuthErrorBody, type OAuthErrorCode } from "./errors.js";

export { CORS_HEADERS, NO_STORE_HEADERS, parseBasicAuth } from "./http.js";

export { extractBearerToken, generateToken, hashToken, timingSafeEqualString } from "./tokens.js";

export {
  buildRedirectUrl,
  CLIENT_AUTH_METHODS,
  computeCodeChallenge,
  describeRedirectUri,
  inspectRedirectUri,
  isAcceptedResource,
  isClientMetadataDocumentUrl,
  isValidCodeChallenge,
  isValidCodeVerifier,
  isValidRedirectUri,
  LIMITS,
  matchRedirectUri,
  parseScope,
  sanitizeClientName,
  validateClientMetadataDocument,
  validateRedirectUris,
  validateRegistration,
  verifyPkce,
  type ClientAuthMethod,
  type ClientMetadataDocument,
  type RedirectUriKind,
  type RegistrationInfo,
} from "./rules.js";

export { fetchJsonSafely, isPrivateIp, UnsafeFetchError, type DnsLookup, type FetchLike, type ResolvedAddress, type SafeFetchOptions } from "./ssrf.js";
