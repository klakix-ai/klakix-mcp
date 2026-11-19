/**
 * OAuth error codes used by this server (RFC 6749 §4.1.2.1 and §5.2, RFC 7591 §3.2.2,
 * RFC 8707 §2).
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied"
  | "unsupported_response_type"
  | "server_error"
  | "temporarily_unavailable"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata";

/** RFC 6749 error object as sent in JSON bodies and redirect queries. */
export interface OAuthErrorBody {
  error: OAuthErrorCode;
  error_description?: string;
}

/**
 * Strips characters that RFC 6749 §5.2 forbids in `error_description`
 * (only %x20-21 / %x23-5B / %x5D-7E are allowed) and caps the length at 300.
 */
export function sanitizeErrorDescription(description: string): string {
  return description.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, "").slice(0, 300);
}

/** Builds an RFC 6749 error object with an ASCII-only description. */
export function oauthErrorBody(code: OAuthErrorCode, description?: string): OAuthErrorBody {
  return description ? { error: code, error_description: sanitizeErrorDescription(description) } : { error: code };
}

/**
 * Error thrown inside endpoint handlers. The handlers turn it into an RFC 6749
 * JSON response with CORS and no-store headers.
 */
export class OAuthError extends Error {
  /**
   * @param code - OAuth error code.
   * @param description - Developer-facing description (made ASCII-safe on output).
   * @param status - HTTP status, 400 by default.
   * @param headers - Extra response headers, for example `WWW-Authenticate` or `Retry-After`.
   */
  constructor(
    public readonly code: OAuthErrorCode,
    public readonly description?: string,
    public readonly status = 400,
    public readonly headers: Record<string, string> = {},
  ) {
    super(description ?? code);
    this.name = "OAuthError";
  }

  /** The RFC 6749 JSON body for this error. */
  toJSON(): OAuthErrorBody {
    return oauthErrorBody(this.code, this.description);
  }
}
