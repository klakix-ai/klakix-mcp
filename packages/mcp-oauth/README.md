# @klakix/mcp-oauth

OAuth 2.1 authorization server for remote MCP servers. It implements what MCP clients such as Claude, ChatGPT, Cursor and VS Code expect from a server that requires sign-in: metadata discovery, dynamic client registration, Client ID Metadata Documents, the authorization code flow with PKCE, refresh token rotation and revocation.

- **Storage-agnostic.** You implement a small `OAuthStore` interface on your database. A `MemoryStore` is included for tests and examples.
- **Zero dependencies.** Only Node.js built-ins (`node:crypto`, `node:dns`, `node:https`, `node:net`).
- **Web Fetch API handlers.** Every endpoint is a `(Request) => Promise<Response>` function, so it mounts directly in Next.js route handlers, Hono, Bun, Deno or a small adapter for `node:http`.
- **You own the consent page.** The library validates the request and signs it; your application renders the screen, checks the session and calls `approve` or `deny`.

This code runs in production behind the [Klakix MCP server](https://klakix.com/mcp).

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Mounting the endpoints](#mounting-the-endpoints)
- [The consent page](#the-consent-page)
- [Protecting the MCP endpoint](#protecting-the-mcp-endpoint)
- [Implementing OAuthStore](#implementing-oauthstore)
- [Options](#options)
- [Security properties](#security-properties)
- [Standards](#standards)

## Installation

```sh
npm install @klakix/mcp-oauth
```

Node.js 20 or newer.

## Quick start

```ts
import { createOAuthServer, MemoryStore } from "@klakix/mcp-oauth";

export const oauth = createOAuthServer({
  issuer: "https://example.com",
  resource: "https://example.com/mcp",
  scopes: [
    { name: "mcp:read", description: "Read your projects" },
    { name: "mcp:write", description: "Create and change projects" },
  ],
  store: new MemoryStore(), // use your own OAuthStore in production
  secret: process.env.OAUTH_CONSENT_SECRET!, // at least 32 bytes
});
```

The returned object contains:

| Member | Purpose |
| --- | --- |
| `authorizationServerMetadata` | `GET` handler, RFC 8414 metadata |
| `protectedResourceMetadata` | `GET` handler, RFC 9728 metadata |
| `register` | `POST` handler, dynamic client registration |
| `token` | `POST` handler, `authorization_code` and `refresh_token` grants |
| `revoke` | `POST` handler, token revocation |
| `authorize.parse(params, userId?)` | Validates an authorization request for your consent page |
| `authorize.approve(consentToken, userId)` | Issues a code, returns the redirect URL |
| `authorize.deny(consentToken)` | Returns the `access_denied` redirect URL |
| `verifyAccessToken(token)` / `authenticate(request)` | Resolves a bearer token to `{ userId, clientId, scopes, grantId }` |
| `wwwAuthenticate(error?, scope?)` | Header value for 401/403 responses from the MCP endpoint |
| `revokeGrant(grantId)` | Ends a connection, for a "connected apps" page |
| `cleanup()` | Removes expired codes, ended grants and abandoned clients |
| `endpoints`, `wellKnownPaths`, `resourceMetadataUrl` | Resolved URLs and paths for routing |

Handlers answer `OPTIONS` preflight requests themselves and add CORS and `Cache-Control: no-store` headers.

## Mounting the endpoints

Default endpoint paths are `/oauth/authorize` (your consent page), `/oauth/token`, `/oauth/register` and `/oauth/revoke`, all relative to the issuer. Change them with the `endpoints` option. Mount the metadata handlers at every path in `oauth.wellKnownPaths`; for the example above that is:

- `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server/mcp`
- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`

### Next.js (App Router)

```ts
// app/oauth/token/route.ts
import { oauth } from "@/lib/oauth";

export const POST = oauth.token;
export const OPTIONS = oauth.token;
```

Repeat for `register` and `revoke`. For the metadata, add `app/.well-known/oauth-authorization-server/route.ts` with `export const GET = oauth.authorizationServerMetadata; export const OPTIONS = GET;`, and the same for the other well-known paths (or rewrite them to one route in middleware).

### Hono

```ts
import { Hono } from "hono";
import { oauth } from "./oauth";

const app = new Hono();
for (const path of oauth.wellKnownPaths.authorizationServer) app.all(path, (c) => oauth.authorizationServerMetadata(c.req.raw));
for (const path of oauth.wellKnownPaths.protectedResource) app.all(path, (c) => oauth.protectedResourceMetadata(c.req.raw));
app.all("/oauth/register", (c) => oauth.register(c.req.raw));
app.all("/oauth/token", (c) => oauth.token(c.req.raw));
app.all("/oauth/revoke", (c) => oauth.revoke(c.req.raw));
```

### Node.js `http`

`node:http` uses its own request objects, so convert them once:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { oauth } from "./oauth";

const routes = new Map<string, (r: Request) => Promise<Response>>([
  ...oauth.wellKnownPaths.authorizationServer.map((p) => [p, oauth.authorizationServerMetadata] as const),
  ...oauth.wellKnownPaths.protectedResource.map((p) => [p, oauth.protectedResourceMetadata] as const),
  ["/oauth/register", oauth.register],
  ["/oauth/token", oauth.token],
  ["/oauth/revoke", oauth.revoke],
]);

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", "https://example.com");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  const handler = routes.get(new URL(req.url ?? "/", "http://x").pathname);
  if (!handler) return send(res, new Response("Not found", { status: 404 }));
  await send(res, await handler(toRequest(req)));
}).listen(3000);
```

## The consent page

The authorization endpoint is a page in your application. The flow:

1. Call `authorize.parse(searchParams)` without a user. If the result is `type: "error_page"`, show an error and never redirect: the client or redirect URI is not trusted. If it is `type: "redirect"`, send the user to `result.redirectTo`.
2. If the user is not signed in, send them to your login page and back.
3. Call `authorize.parse(searchParams, user.id)` again. It returns `consentToken`, a signed copy of the request bound to that user, valid for 15 minutes.
4. Render the client name, `result.redirect.display` (where the user will be sent), and the scopes with their descriptions. The form posts only the token and the decision.
5. On submit, verify the session and the request origin (same-origin check or CSRF token), then call `approve(token, user.id)` or `deny(token)` and answer with a `303` redirect.

```tsx
// app/oauth/authorize/page.tsx (Next.js)
import { redirect } from "next/navigation";
import { oauth } from "@/lib/oauth";
import { getSession } from "@/lib/session";

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const params = await searchParams;
  const check = await oauth.authorize.parse(params);
  if (!check.ok && check.type === "redirect") redirect(check.redirectTo);
  if (!check.ok) return <p>This connection request is not valid: {check.description}</p>;

  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(params as Record<string, string>)}`)}`);

  const result = await oauth.authorize.parse(params, session.user.id);
  if (!result.ok) return <p>This connection request is not valid.</p>;
  return (
    <form method="post" action="/oauth/authorize/decision">
      <h1>{result.client.name} wants to access your account</h1>
      <p>You will be sent back to {result.redirect.display}.</p>
      <ul>
        {result.scopes.map((s) => (
          <li key={s.name}>{s.description}</li>
        ))}
      </ul>
      <input type="hidden" name="consent" value={result.consentToken ?? ""} />
      <button name="decision" value="deny">Cancel</button>
      <button name="decision" value="approve">Allow</button>
    </form>
  );
}
```

```ts
// app/oauth/authorize/decision/route.ts
import { oauth } from "@/lib/oauth";
import { getSession, assertSameOrigin } from "@/lib/session";

export async function POST(request: Request) {
  assertSameOrigin(request);
  const session = await getSession();
  const form = await request.formData();
  const token = form.get("consent");
  const result =
    form.get("decision") === "approve" && session
      ? await oauth.authorize.approve(token, session.user.id)
      : await oauth.authorize.deny(token);

  const location = result.ok
    ? result.redirectTo
    : result.authorizationQuery
      ? `${oauth.endpoints.authorization}?${result.authorizationQuery}` // expired or changed: show the screen again
      : "/oauth/error";
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
```

Serve the consent page with `X-Frame-Options: DENY` (or `Content-Security-Policy: frame-ancestors 'none'`) so it cannot be framed.

## Protecting the MCP endpoint

```ts
export async function POST(request: Request) {
  const auth = await oauth.authenticate(request);
  if (!auth) {
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": oauth.wwwAuthenticate("invalid_token") } });
  }
  if (!auth.scopes.includes("mcp:write")) {
    return new Response(null, { status: 403, headers: { "WWW-Authenticate": oauth.wwwAuthenticate("insufficient_scope", "mcp:write") } });
  }
  // handle the MCP request for auth.userId
}
```

A 401 without a token (`oauth.wwwAuthenticate()`) is what starts the OAuth flow in MCP clients: they read `resource_metadata`, discover the authorization server and register.

## Implementing OAuthStore

The store holds four kinds of records: clients, authorization codes and grants (a grant is one user's connection to one client, holding the current access and refresh token hashes). Tokens, codes and client secrets are never passed to the store in plain text; every lookup key is a hex SHA-256 hash. Times are milliseconds since the epoch.

Two methods carry the security guarantees and must be atomic:

- `markAuthorizationCodeUsed(codeHash, usedAt)` sets `usedAt` only if it is still null and reports whether it did. This makes codes single-use.
- `rotateGrantTokens(grantId, expectedRefreshTokenHash, update)` replaces the token hashes only if the grant is not revoked and still holds the expected refresh token hash. This makes concurrent refreshes safe.

### Postgres

```sql
create table oauth_clients (
  id text primary key,
  registration_type text not null,      -- 'dynamic' | 'metadata_document'
  name text not null,
  redirect_uris jsonb not null,
  auth_method text not null,
  secret_hash text,
  client_uri text, logo_uri text, software text,
  grant_types jsonb not null,
  created_at bigint not null, updated_at bigint not null
);

create table oauth_codes (
  code_hash text primary key,
  client_id text not null, user_id text not null,
  redirect_uri text not null, code_challenge text not null,
  scopes jsonb not null, resource text,
  expires_at bigint not null, used_at bigint, created_at bigint not null
);

create table oauth_grants (
  id text primary key,
  user_id text not null, client_id text not null,
  scopes jsonb not null, resource text,
  access_token_hash text not null unique, access_token_expires_at bigint not null,
  refresh_token_hash text not null unique, refresh_token_expires_at bigint not null,
  previous_refresh_token_hash text,
  revoked_at bigint, created_at bigint not null, updated_at bigint not null
);
create index on oauth_grants (previous_refresh_token_hash);
create index on oauth_grants (user_id);
```

The atomic operations map to single statements:

```sql
-- markAuthorizationCodeUsed
update oauth_codes set used_at = $2 where code_hash = $1 and used_at is null;  -- true when rowCount = 1

-- rotateGrantTokens
update oauth_grants
   set access_token_hash = $3, access_token_expires_at = $4,
       refresh_token_hash = $5, refresh_token_expires_at = $6,
       previous_refresh_token_hash = $7, updated_at = $8
 where id = $1 and refresh_token_hash = $2 and revoked_at is null;            -- true when rowCount = 1
```

### Redis

Store each record as a JSON string and keep secondary keys for the hash lookups (`grant:at:<hash> -> id`, `grant:rt:<hash> -> id`, `grant:prt:<hash> -> id`). Implement the two atomic methods with a Lua script (or `WATCH`/`MULTI`) that reads the record, checks the condition and writes it back in one step. Give code keys a TTL of the code lifetime plus one day; used codes must outlive their expiry so a replay can still be detected.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `issuer` | required | Issuer URL. https, or http on localhost for development. |
| `resource` | required | URL of the MCP endpoint. |
| `scopes` | required | `{ name, description }[]` in display order. |
| `defaultScopes` | all scopes | Granted when a request names no known scope. |
| `store` | required | Your `OAuthStore`. |
| `secret` | required | HMAC key for consent tokens, at least 32 bytes. Same value on every instance. |
| `tokenPrefixes` | `mcp_at_`, `mcp_rt_`, `mcp_ac_`, `mcp_ci_`, `mcp_cs_` | Prefixes for access token, refresh token, code, client ID and client secret. Distinct prefixes help secret scanners. |
| `accessTokenTtl` | `3600` | Seconds. |
| `refreshTokenTtl` | `5184000` (60 days) | Seconds. |
| `authorizationCodeTtl` | `600` | Seconds. |
| `consentTtl` | `900` | Seconds. |
| `endpoints` | `/oauth/...` | Absolute URLs or paths appended to the issuer. |
| `acceptedResources` | none | Extra accepted `resource` values. The resource URL and the issuer origin are always accepted. |
| `resourceName`, `resourceDocumentation`, `serviceDocumentation` | none | Optional metadata fields. |
| `dynamicClientRegistration` | `true` | Enables the registration endpoint. |
| `clientIdMetadataDocuments` | `true` | Accepts HTTPS URLs as client IDs. |
| `fetch`, `dnsLookup` | built-in | Override the metadata document fetcher and resolver (tests, proxies). |
| `allowRegistration(request)` | none | Return `false` to refuse a registration with 429, for example for per-IP rate limits. |
| `isUserAllowed(userId)` | none | Return `false` for suspended users; checked on approval, code exchange, refresh and token verification. |
| `onError(error)` | `console.error` | Unexpected errors inside handlers. Responses only say `server_error`. |
| `now()` | `Date.now` | Clock, for tests. |

Call `cleanup()` from a scheduled job (daily is enough). It removes codes that expired more than a day ago, grants that were revoked or whose refresh token expired more than 30 days ago, and dynamically registered clients older than 7 days that have no grant and no live code.

## Security properties

- Authorization code flow only, with PKCE `S256` required. No implicit flow, no `plain` challenges.
- Redirect URIs are compared exactly. Loopback `http` redirects (`localhost`, `127.0.0.1`, `[::1]`) may use any port. `javascript:`, `data:`, `file:` and similar schemes, fragments and user info are refused.
- The client and redirect URI are validated before anything else; an untrusted redirect URI never receives a redirect, not even an error.
- Codes are single-use (atomic compare-and-set). A code presented a second time revokes the grant it produced. A wrong verifier, client or redirect URI does not spend the code.
- Refresh tokens rotate on every use. A rotated token presented again revokes the whole grant. Scope cannot be widened on refresh.
- Tokens, codes and client secrets are 256-bit random values stored only as SHA-256 hashes. Secret and PKCE comparisons are constant-time.
- The consent token is an HMAC-signed copy of the request bound to the user, client, redirect URI, PKCE challenge, scopes, state, resource and issuer, valid for 15 minutes. The form cannot change any parameter.
- Client ID Metadata Documents are fetched with SSRF protection: https on the default port only, IP literals and host names resolving to private, loopback, link-local or reserved addresses are refused (IPv4-mapped and NAT64 forms included), the built-in client connects only to addresses that passed the check (DNS rebinding), redirects are not followed, no cookies are sent, 5 second timeout, 64 KiB limit. Documents are cached for an hour (failures for a minute) and only fetched from the consent page, never from the token endpoint.
- Request bodies are capped at 64 KiB and read as a bounded stream. Repeated form parameters are refused.
- `error_description` values are ASCII as required by RFC 6749. Unexpected errors are reported as `server_error` without details.
- Client names are cleaned of control and bidirectional formatting characters to prevent spoofing on the consent screen.

## Standards

- OAuth 2.1 (draft-ietf-oauth-v2-1)
- RFC 6749, OAuth 2.0 (error formats, client authentication)
- RFC 6750, Bearer token usage
- RFC 7009, Token revocation
- RFC 7591, Dynamic client registration
- RFC 7636, PKCE
- RFC 8252, OAuth for native apps (loopback redirects)
- RFC 8414, Authorization server metadata
- RFC 8707, Resource indicators
- RFC 9207, Authorization server issuer identification (`iss`)
- RFC 9728, Protected resource metadata
- MCP authorization specification 2025-11-25, including Client ID Metadata Documents

## License

MIT
