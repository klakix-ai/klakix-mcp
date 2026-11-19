import { describe, expect, it, vi } from "vitest";
import { computeCodeChallenge, createOAuthServer, MemoryStore, type DnsLookup, type FetchLike, type OAuthServerOptions } from "../src/index.js";

const ISSUER = "https://auth.example.com";
const RESOURCE = "https://auth.example.com/mcp";
const REDIRECT = "https://client.example/callback";
const SECRET = "test-secret-at-least-thirty-two-bytes-long";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = computeCodeChallenge(VERIFIER);

function setup(overrides: Partial<OAuthServerOptions> = {}) {
  let clock = 1_800_000_000_000;
  const store = new MemoryStore();
  const server = createOAuthServer({
    issuer: ISSUER,
    resource: RESOURCE,
    scopes: [
      { name: "mcp:read", description: "Read your data" },
      { name: "mcp:write", description: "Create and change data" },
    ],
    store,
    secret: SECRET,
    now: () => clock,
    onError: () => undefined,
    ...overrides,
  });
  return { server, store, advance: (ms: number) => (clock += ms) };
}

type Server = ReturnType<typeof setup>["server"];

async function registerClient(server: Server, body: Record<string, unknown> = {}) {
  const res = await server.register(
    new Request(`${ISSUER}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT], ...body }),
    }),
  );
  return { res, json: (await res.json()) as Record<string, string> };
}

function form(url: string, params: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

async function postToken(server: Server, params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await server.token(form(`${ISSUER}/oauth/token`, params, headers));
  return { res, json: (await res.json()) as Record<string, string> };
}

function authorizeParams(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "mcp:read mcp:write",
    state: "xyz",
    resource: RESOURCE,
    ...extra,
  });
}

/** Runs consent and returns the authorization code. */
async function getCode(server: Server, clientId: string, userId = "user-1", extra: Record<string, string> = {}) {
  const parsed = await server.authorize.parse(authorizeParams(clientId, extra), userId);
  if (!parsed.ok || !parsed.consentToken) throw new Error(`parse failed: ${JSON.stringify(parsed)}`);
  const decision = await server.authorize.approve(parsed.consentToken, userId);
  if (!decision.ok) throw new Error(`approve failed: ${decision.reason}`);
  const url = new URL(decision.redirectTo);
  return { code: url.searchParams.get("code") ?? "", url };
}

function basic(id: string, secret: string) {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}

describe("metadata", () => {
  it("serves RFC 8414 authorization server metadata", async () => {
    const { server } = setup({ serviceDocumentation: "https://docs.example.com/mcp" });
    const res = await server.authorizationServerMetadata(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["mcp:read", "mcp:write"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      service_documentation: "https://docs.example.com/mcp",
    });
  });

  it("serves RFC 9728 protected resource metadata and the WWW-Authenticate value", async () => {
    const { server } = setup({ resourceName: "Example MCP" });
    const res = await server.protectedResourceMetadata(new Request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`));
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Example MCP",
    });
    expect(server.resourceMetadataUrl).toBe(`${ISSUER}/.well-known/oauth-protected-resource/mcp`);
    expect(server.wwwAuthenticate()).toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`);
    expect(server.wwwAuthenticate("insufficient_scope", 'mcp:write "x')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="mcp:write"`,
    );
    expect(server.wellKnownPaths.protectedResource).toEqual(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]);
    expect(server.wellKnownPaths.authorizationServer).toContain("/.well-known/oauth-authorization-server");
  });

  it("answers CORS preflight and rejects other methods", async () => {
    const { server } = setup();
    const pre = await server.token(new Request(`${ISSUER}/oauth/token`, { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
    const get = await server.token(new Request(`${ISSUER}/oauth/token`));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("validates options", () => {
    expect(() => setup({ secret: "short" })).toThrow(/secret/);
    expect(() => setup({ issuer: "http://auth.example.com" })).toThrow(/https/);
    expect(() => setup({ issuer: "http://localhost:3000" })).not.toThrow();
    expect(() => setup({ scopes: [] })).toThrow(/scope/);
    expect(() => setup({ scopes: [{ name: "has space", description: "" }] })).toThrow(/scope/);
    expect(() => setup({ defaultScopes: ["unknown"] })).toThrow(/defaultScopes/);
    expect(() => setup({ tokenPrefixes: { accessToken: "mcp_", refreshToken: "mcp_rt_" } })).toThrow(/prefix/);
    expect(() => setup({ accessTokenTtl: 0 })).toThrow(/accessTokenTtl/);
  });
});

describe("full authorization code flow", () => {
  it("register -> parse -> approve -> token -> refresh -> reuse detection -> revoke", async () => {
    const { server } = setup();

    const { res: regRes, json: client } = await registerClient(server, { scope: "mcp:read openid" });
    expect(regRes.status).toBe(201);
    expect(client.client_id).toMatch(/^mcp_ci_[A-Za-z0-9]{43}$/);
    expect(client).not.toHaveProperty("client_secret");
    expect(client).toMatchObject({ client_name: "Test Client", token_endpoint_auth_method: "none", scope: "mcp:read" });
    const clientId = client.client_id ?? "";

    // Before sign-in: the request validates, but no consent token is issued.
    const anonymous = await server.authorize.parse(authorizeParams(clientId));
    expect(anonymous).toMatchObject({ ok: true, consentToken: null });

    const parsed = await server.authorize.parse(authorizeParams(clientId), "user-1");
    expect(parsed).toMatchObject({
      ok: true,
      client: { id: clientId, name: "Test Client", registrationType: "dynamic" },
      redirect: { kind: "https", display: "client.example" },
      scopes: [
        { name: "mcp:read", description: "Read your data" },
        { name: "mcp:write", description: "Create and change data" },
      ],
      state: "xyz",
      resource: RESOURCE,
    });
    if (!parsed.ok || !parsed.consentToken) throw new Error("expected a consent token");

    const decision = await server.authorize.approve(parsed.consentToken, "user-1");
    if (!decision.ok) throw new Error(decision.reason);
    const redirect = new URL(decision.redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("iss")).toBe(ISSUER);
    const code = redirect.searchParams.get("code") ?? "";
    expect(code).toMatch(/^mcp_ac_/);

    const first = await postToken(server, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId, resource: RESOURCE });
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("cache-control")).toBe("no-store");
    expect(first.json).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read mcp:write" });
    expect(first.json.access_token).toMatch(/^mcp_at_/);
    expect(first.json.refresh_token).toMatch(/^mcp_rt_/);

    const info = await server.verifyAccessToken(first.json.access_token);
    expect(info).toMatchObject({ userId: "user-1", clientId, scopes: ["mcp:read", "mcp:write"], resource: RESOURCE });
    const viaHeader = await server.authenticate(new Request(RESOURCE, { headers: { authorization: `Bearer ${first.json.access_token}` } }));
    expect(viaHeader?.grantId).toBe(info?.grantId);

    // Refresh rotates both tokens.
    const second = await postToken(server, { grant_type: "refresh_token", refresh_token: first.json.refresh_token ?? "", client_id: clientId });
    expect(second.res.status).toBe(200);
    expect(second.json.refresh_token).not.toBe(first.json.refresh_token);
    expect(await server.verifyAccessToken(first.json.access_token)).toBeNull();
    expect(await server.verifyAccessToken(second.json.access_token)).not.toBeNull();

    // The rotated refresh token comes back: the whole grant is revoked.
    const replay = await postToken(server, { grant_type: "refresh_token", refresh_token: first.json.refresh_token ?? "", client_id: clientId });
    expect(replay.res.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
    expect(await server.verifyAccessToken(second.json.access_token)).toBeNull();
    const afterReplay = await postToken(server, { grant_type: "refresh_token", refresh_token: second.json.refresh_token ?? "", client_id: clientId });
    expect(afterReplay.json.error).toBe("invalid_grant");

    // A fresh connection can be revoked with its refresh token.
    const { code: code2 } = await getCode(server, clientId);
    const third = await postToken(server, { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId });
    const revokeRes = await server.revoke(form(`${ISSUER}/oauth/revoke`, { token: third.json.refresh_token ?? "", client_id: clientId }));
    expect(revokeRes.status).toBe(200);
    expect(await server.verifyAccessToken(third.json.access_token)).toBeNull();
    // Unknown tokens are accepted silently (RFC 7009 §2.2).
    expect((await server.revoke(form(`${ISSUER}/oauth/revoke`, { token: "mcp_at_unknown" }))).status).toBe(200);
  });

  it("a replayed code fails and revokes the grant it produced", async () => {
    const { server } = setup();
    const clientId = (await registerClient(server)).json.client_id ?? "";
    const { code } = await getCode(server, clientId);
    const params = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId };
    const first = await postToken(server, params);
    expect(first.res.status).toBe(200);
    const second = await postToken(server, params);
    expect(second.json.error).toBe("invalid_grant");
    expect(await server.verifyAccessToken(first.json.access_token)).toBeNull();
  });

  it("a wrong PKCE verifier, redirect or client does not spend the code", async () => {
    const { server } = setup();
    const clientId = (await registerClient(server)).json.client_id ?? "";
    const other = (await registerClient(server)).json.client_id ?? "";
    const { code } = await getCode(server, clientId);
    const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId };

    expect((await postToken(server, { ...base, code_verifier: "a".repeat(43) })).json.error).toBe("invalid_grant");
    expect((await postToken(server, { ...base, code_verifier: "short" })).json).toMatchObject({ error: "invalid_grant", error_description: "code_verifier is malformed." });
    expect((await postToken(server, { ...base, redirect_uri: "https://client.example/other" })).json.error).toBe("invalid_grant");
    expect((await postToken(server, { ...base, client_id: other })).json.error).toBe("invalid_grant");
    expect((await postToken(server, { ...base, resource: "https://evil.example/mcp" })).json.error).toBe("invalid_target");
    expect((await postToken(server, base)).res.status).toBe(200);
  });

  it("codes expire after 10 minutes", async () => {
    const { server, advance } = setup();
    const clientId = (await registerClient(server)).json.client_id ?? "";
    const { code } = await getCode(server, clientId);
    advance(10 * 60_000 + 1);
    const r = await postToken(server, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId });
    expect(r.json.error).toBe("invalid_grant");
  });

  it("access tokens expire; refresh cannot widen scope or switch client", async () => {
    const { server, advance } = setup();
    const clientId = (await registerClient(server)).json.client_id ?? "";
    const other = (await registerClient(server)).json.client_id ?? "";
    const { code } = await getCode(server, clientId, "user-1", { scope: "mcp:read" });
    const t = await postToken(server, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId });
    expect(t.json.scope).toBe("mcp:read");

    expect((await postToken(server, { grant_type: "refresh_token", refresh_token: t.json.refresh_token ?? "", scope: "mcp:write" })).json.error).toBe("invalid_scope");
    expect((await postToken(server, { grant_type: "refresh_token", refresh_token: t.json.refresh_token ?? "", client_id: other })).json.error).toBe("invalid_grant");

    advance(3600_000);
    expect(await server.verifyAccessToken(t.json.access_token)).toBeNull();
    const refreshed = await postToken(server, { grant_type: "refresh_token", refresh_token: t.json.refresh_token ?? "", scope: "mcp:read" });
    expect(refreshed.res.status).toBe(200);
  });
});

describe("confidential clients", () => {
  it("client_secret_basic and client_secret_post", async () => {
    const { server } = setup();
    const { json: reg } = await registerClient(server, { token_endpoint_auth_method: "client_secret_basic" });
    const clientId = reg.client_id ?? "";
    const secret = reg.client_secret ?? "";
    expect(secret).toMatch(/^mcp_cs_/);
    expect(reg.client_secret_expires_at).toBe(0);

    const { code } = await getCode(server, clientId);
    const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER };

    const missing = await postToken(server, { ...base, client_id: clientId });
    expect(missing.res.status).toBe(401);
    expect(missing.json.error).toBe("invalid_client");

    const wrong = await postToken(server, base, { authorization: basic(clientId, `${secret}x`) });
    expect(wrong.res.status).toBe(401);
    expect(wrong.res.headers.get("www-authenticate")).toBe('Basic realm="oauth"');

    const both = await postToken(server, { ...base, client_secret: secret }, { authorization: basic(clientId, secret) });
    expect(both.json.error).toBe("invalid_request");

    const ok = await postToken(server, base, { authorization: basic(clientId, secret) });
    expect(ok.res.status).toBe(200);

    // Refresh and revocation also require the secret; client_secret_post is accepted too.
    const noAuth = await postToken(server, { grant_type: "refresh_token", refresh_token: ok.json.refresh_token ?? "" });
    expect(noAuth.res.status).toBe(401);
    const revokeNoAuth = await server.revoke(form(`${ISSUER}/oauth/revoke`, { token: ok.json.access_token ?? "" }));
    expect(revokeNoAuth.status).toBe(401);
    const post = await postToken(server, { grant_type: "refresh_token", refresh_token: ok.json.refresh_token ?? "", client_id: clientId, client_secret: secret });
    expect(post.res.status).toBe(200);
  });

  it("rejects malformed Basic headers and unknown clients", async () => {
    const { server } = setup();
    expect((await postToken(server, { grant_type: "authorization_code", code: "x" }, { authorization: "Basic !!!" })).json.error).toBe("invalid_client");
    expect((await postToken(server, { grant_type: "authorization_code", code: "x", client_id: "mcp_ci_nope" })).res.status).toBe(401);
    expect((await postToken(server, { grant_type: "authorization_code", code: "x" })).json).toMatchObject({ error: "invalid_client" });
  });
});

describe("authorization request validation", () => {
  it("shows an error page when the client or redirect URI cannot be trusted", async () => {
    const { server } = setup();
    const clientId = (await registerClient(server, { redirect_uris: [REDIRECT, "http://127.0.0.1/cb"] })).json.client_id ?? "";
    expect(await server.authorize.parse({})).toMatchObject({ ok: false, type: "error_page", reason: "missing_parameters" });
    expect(await server.authorize.parse(authorizeParams("mcp_ci_unknown"))).toMatchObject({ ok: false, type: "error_page", reason: "unknown_client" });
    expect(await server.authorize.parse(authorizeParams(clientId, { redirect_uri: "https://evil.example/cb" }))).toMatchObject({
      ok: false,
      type: "error_page",
      reason: "invalid_redirect_uri",
    });
    // Loopback redirect URIs may use any port.
    expect(await server.authorize.parse(authorizeParams(clientId, { redirect_uri: "http://127.0.0.1:49152/cb" }))).toMatchObject({
      ok: true,
      redirect: { kind: "loopback", display: "127.0.0.1" },
    });
  });

  it("redirects with an RFC error once the redirect URI is verified", async () => {
    const { server } = setup();
    const clientId = (await registerClient(server)).json.client_id ?? "";
    const cases: [Record<string, string>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: "too-short" }, "invalid_request"],
      [{ resource: "https://evil.example/mcp" }, "invalid_target"],
      [{ state: "s".repeat(3000) }, "invalid_request"],
    ];
    for (const [extra, error] of cases) {
      const r = await server.authorize.parse(authorizeParams(clientId, extra), "user-1");
      expect(r, JSON.stringify(extra)).toMatchObject({ ok: false, type: "redirect", error });
      if (r.ok || r.type !== "redirect") continue;
      const url = new URL(r.redirectTo);
      expect(url.searchParams.get("error")).toBe(error);
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      expect(url.searchParams.get("state")).toBe(extra.state ? null : "xyz");
      expect(url.searchParams.get("error_description")).toMatch(/^[\x20-\x7e]+$/);
    }
    const dup = authorizeParams(clientId);
    dup.append("scope", "mcp:read");
    expect(await server.authorize.parse(dup)).toMatchObject({ ok: false, type: "redirect", error: "invalid_request" });
    const noPkce = authorizeParams(clientId);
    noPkce.delete("code_challenge_method");
    expect(await server.authorize.parse(noPkce)).toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("unknown scopes fall back to the default scopes", async () => {
    const { server } = setup({ defaultScopes: ["mcp:read"] });
    const clientId = (await registerClient(server)).json.client_id ?? "";
    const r = await server.authorize.parse(authorizeParams(clientId, { scope: "openid profile" }));
    expect(r).toMatchObject({ ok: true, scopes: [{ name: "mcp:read" }] });
  });
});

describe("consent decisions", () => {
  async function consent(server: Server, userId = "user-1") {
    const clientId = (await registerClient(server)).json.client_id ?? "";
    const parsed = await server.authorize.parse(authorizeParams(clientId), userId);
    if (!parsed.ok || !parsed.consentToken) throw new Error("parse failed");
    return { clientId, token: parsed.consentToken };
  }

  it("deny redirects with access_denied", async () => {
    const { server } = setup();
    const { token } = await consent(server);
    const r = await server.authorize.deny(token);
    if (!r.ok) throw new Error(r.reason);
    const url = new URL(r.redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    expect(url.searchParams.get("code")).toBeNull();
  });

  it("binds the token to the user, the issuer and a 15-minute window", async () => {
    const { server, advance } = setup();
    const { token } = await consent(server);
    expect(await server.authorize.approve(token, "user-2")).toMatchObject({ ok: false, reason: "user_mismatch" });
    expect(await server.authorize.approve(`${token}x`, "user-1")).toEqual({ ok: false, reason: "invalid_token" });
    expect(await server.authorize.approve(undefined, "user-1")).toEqual({ ok: false, reason: "invalid_token" });

    const otherIssuer = setup({ issuer: "https://other.example.com", resource: "https://other.example.com/mcp" }).server;
    expect(await otherIssuer.authorize.approve(token, "user-1")).toEqual({ ok: false, reason: "invalid_token" });

    advance(15 * 60_000 + 1);
    const expired = await server.authorize.approve(token, "user-1");
    expect(expired).toMatchObject({ ok: false, reason: "expired" });
    if (expired.ok) return;
    expect(new URLSearchParams(expired.authorizationQuery).get("code_challenge")).toBe(CHALLENGE);
  });

  it("isUserAllowed blocks approval, exchange and token use", async () => {
    let allowed = true;
    const { server } = setup({ isUserAllowed: () => allowed });
    const { clientId, token } = await consent(server);
    const approved = await server.authorize.approve(token, "user-1");
    if (!approved.ok) throw new Error(approved.reason);
    const code = new URL(approved.redirectTo).searchParams.get("code") ?? "";
    const t = await postToken(server, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId });
    expect(t.res.status).toBe(200);

    allowed = false;
    expect(await server.verifyAccessToken(t.json.access_token)).toBeNull();
    expect((await postToken(server, { grant_type: "refresh_token", refresh_token: t.json.refresh_token ?? "" })).json.error).toBe("invalid_grant");
    const again = await consent(server);
    expect(await server.authorize.approve(again.token, "user-1")).toMatchObject({ ok: false, reason: "user_not_allowed" });
  });

  it("revokeGrant ends a connection", async () => {
    const { server } = setup();
    const { clientId, token } = await consent(server);
    const approved = await server.authorize.approve(token, "user-1");
    if (!approved.ok) throw new Error(approved.reason);
    const code = new URL(approved.redirectTo).searchParams.get("code") ?? "";
    const t = await postToken(server, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId });
    const info = await server.verifyAccessToken(t.json.access_token);
    await server.revokeGrant(info?.grantId ?? "");
    expect(await server.verifyAccessToken(t.json.access_token)).toBeNull();
  });
});

describe("registration and token endpoint errors", () => {
  it("returns RFC 7591 errors", async () => {
    const { server } = setup();
    const bad = await registerClient(server, { redirect_uris: ["http://evil.example/cb"] });
    expect(bad.res.status).toBe(400);
    expect(bad.json.error).toBe("invalid_redirect_uri");
    expect(bad.res.headers.get("access-control-allow-origin")).toBe("*");

    const notJson = await server.register(new Request(`${ISSUER}/oauth/register`, { method: "POST", body: "{" }));
    expect(await notJson.json()).toMatchObject({ error: "invalid_client_metadata" });

    const big = await server.register(new Request(`${ISSUER}/oauth/register`, { method: "POST", body: JSON.stringify({ x: "a".repeat(70_000) }) }));
    expect(big.status).toBe(413);
  });

  it("allowRegistration can refuse with 429; registration can be disabled", async () => {
    const limited = setup({ allowRegistration: () => false }).server;
    const r = await registerClient(limited);
    expect(r.res.status).toBe(429);
    expect(r.res.headers.get("retry-after")).toBe("3600");
    expect(r.json.error).toBe("temporarily_unavailable");

    const off = setup({ dynamicClientRegistration: false }).server;
    expect((await registerClient(off)).res.status).toBe(404);
    const meta = (await (await off.authorizationServerMetadata(new Request(ISSUER))).json()) as Record<string, unknown>;
    expect(meta).not.toHaveProperty("registration_endpoint");
  });

  it("token endpoint errors use RFC 6749 JSON", async () => {
    const { server } = setup();
    expect((await postToken(server, {})).json).toEqual({ error: "invalid_request", error_description: "grant_type is required." });
    expect((await postToken(server, { grant_type: "client_credentials" })).json.error).toBe("unsupported_grant_type");
    expect((await postToken(server, { grant_type: "refresh_token" })).json.error).toBe("invalid_request");
    expect((await postToken(server, { grant_type: "refresh_token", refresh_token: "not-ours" })).json.error).toBe("invalid_grant");
    expect((await server.revoke(form(`${ISSUER}/oauth/revoke`, {}))).status).toBe(400);
  });

  it("unexpected store errors become server_error without leaking details", async () => {
    const store = new MemoryStore();
    store.getClient = async () => {
      throw new Error("database password is hunter2");
    };
    const onError = vi.fn();
    const { server } = setup({ store, onError });
    const r = await postToken(server, { grant_type: "authorization_code", client_id: "mcp_ci_x", code: "c" });
    expect(r.res.status).toBe(500);
    expect(r.json).toEqual({ error: "server_error" });
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("Client ID Metadata Documents", () => {
  const DOC_URL = "https://client.example/oauth/metadata.json";
  const doc = { client_id: DOC_URL, client_name: "Doc Client", redirect_uris: [REDIRECT] };
  const publicDns: DnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const privateDns: DnsLookup = async () => [{ address: "169.254.169.254", family: 4 }];

  it("fetches the document on the consent page and uses the stored copy at the token endpoint", async () => {
    const fetch = vi.fn<FetchLike>(async () => Response.json(doc));
    const { server } = setup({ fetch, dnsLookup: publicDns });
    const parsed = await server.authorize.parse(authorizeParams(DOC_URL), "user-1");
    expect(parsed).toMatchObject({ ok: true, client: { id: DOC_URL, name: "Doc Client", registrationType: "metadata_document" } });
    expect(fetch).toHaveBeenCalledOnce();

    const { code } = await getCode(server, DOC_URL);
    expect(fetch).toHaveBeenCalledOnce(); // cached for an hour
    const t = await postToken(server, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: DOC_URL });
    expect(t.res.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refuses documents behind private addresses (SSRF)", async () => {
    const fetch = vi.fn<FetchLike>(async () => Response.json(doc));
    const { server } = setup({ fetch, dnsLookup: privateDns });
    expect(await server.authorize.parse(authorizeParams(DOC_URL), "user-1")).toMatchObject({ ok: false, type: "error_page", reason: "unknown_client" });
    expect(fetch).not.toHaveBeenCalled();

    const literal = "https://10.0.0.1/metadata.json";
    expect(await server.authorize.parse(authorizeParams(literal), "user-1")).toMatchObject({ ok: false, reason: "unknown_client" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses invalid documents, redirects and non-200 responses", async () => {
    for (const response of [
      () => Response.json({ ...doc, client_id: "https://evil.example/x.json" }),
      () => Response.json({ ...doc, client_secret: "s" }),
      () => new Response(null, { status: 302, headers: { location: DOC_URL } }),
      () => new Response("missing", { status: 404 }),
    ]) {
      const { server } = setup({ fetch: async () => response(), dnsLookup: publicDns });
      expect(await server.authorize.parse(authorizeParams(DOC_URL), "user-1")).toMatchObject({ ok: false, reason: "unknown_client" });
    }
  });

  it("can be disabled", async () => {
    const fetch = vi.fn<FetchLike>(async () => Response.json(doc));
    const { server } = setup({ fetch, dnsLookup: publicDns, clientIdMetadataDocuments: false });
    expect(await server.authorize.parse(authorizeParams(DOC_URL), "user-1")).toMatchObject({ ok: false, reason: "unknown_client" });
    expect(fetch).not.toHaveBeenCalled();
    const meta = (await (await server.authorizationServerMetadata(new Request(ISSUER))).json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(false);
  });
});

describe("cleanup", () => {
  it("removes expired codes, ended grants and abandoned dynamic clients", async () => {
    const { server, advance } = setup();
    const used = (await registerClient(server)).json.client_id ?? "";
    await registerClient(server); // never used
    const { code } = await getCode(server, used);
    const t = await postToken(server, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: used });
    await getCode(server, used); // a code that is never exchanged

    expect(await server.cleanup()).toEqual({ codes: 0, grants: 0, clients: 0 });
    advance(8 * 24 * 3600_000);
    expect(await server.cleanup()).toEqual({ codes: 2, grants: 0, clients: 1 });

    await server.revoke(form(`${ISSUER}/oauth/revoke`, { token: t.json.refresh_token ?? "", client_id: used }));
    advance(31 * 24 * 3600_000);
    // The ended grant goes first; its client is then unused and old, so it goes in the same pass.
    expect(await server.cleanup()).toEqual({ codes: 0, grants: 1, clients: 1 });
    expect(await server.cleanup()).toEqual({ codes: 0, grants: 0, clients: 0 });
  });
});
