import { describe, expect, it } from "vitest";
import {
  buildRedirectUrl,
  computeCodeChallenge,
  describeRedirectUri,
  isAcceptedResource,
  isClientMetadataDocumentUrl,
  isValidCodeChallenge,
  isValidRedirectUri,
  matchRedirectUri,
  oauthErrorBody,
  parseBasicAuth,
  parseScope,
  sanitizeClientName,
  validateClientMetadataDocument,
  validateRedirectUris,
  validateRegistration,
  verifyPkce,
} from "../src/index.js";
import { readOAuthParams } from "../src/http.js";
import { authorizationQueryFromConsent, isConsentFresh, sanitizeHttpsUrl, signConsentToken, verifyConsentToken, type ConsentPayload } from "../src/rules.js";
import { OAuthError } from "../src/errors.js";

const SCOPES = ["mcp:read", "mcp:write"];

describe("PKCE S256", () => {
  // RFC 7636 Appendix B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("matches the RFC example", () => {
    expect(computeCodeChallenge(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("rejects wrong, short, long or malformed verifiers", () => {
    expect(verifyPkce(`${verifier.slice(0, -1)}x`, challenge)).toBe(false);
    expect(verifyPkce("a".repeat(42), computeCodeChallenge("a".repeat(42)))).toBe(false);
    expect(verifyPkce("a".repeat(129), computeCodeChallenge("a".repeat(129)))).toBe(false);
    expect(verifyPkce(`${"a".repeat(43)}!`, computeCodeChallenge(`${"a".repeat(43)}!`))).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce("a".repeat(43), computeCodeChallenge("a".repeat(43)))).toBe(true);
    expect(verifyPkce("A-._~".repeat(25) + "abc", computeCodeChallenge("A-._~".repeat(25) + "abc"))).toBe(true);
  });

  it("accepts only 43-character base64url challenges", () => {
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(isValidCodeChallenge(`${challenge}=`)).toBe(false);
    expect(isValidCodeChallenge(challenge.slice(1))).toBe(false);
    expect(isValidCodeChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM")).toBe(false);
    expect(isValidCodeChallenge(null)).toBe(false);
  });
});

describe("redirect URI rules", () => {
  it("allows https anywhere and http only on loopback", () => {
    expect(isValidRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isValidRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isValidRedirectUri("http://127.0.0.1/cb")).toBe(true);
    expect(isValidRedirectUri("http://[::1]:8080/cb")).toBe(true);
    expect(isValidRedirectUri("http://example.com/cb")).toBe(false);
    expect(isValidRedirectUri("http://localhost.evil.com/cb")).toBe(false);
    expect(isValidRedirectUri("http://127.0.0.2/cb")).toBe(false);
  });

  it("allows private app schemes and rejects dangerous ones", () => {
    expect(isValidRedirectUri("cursor://anysphere.cursor-retrieval/oauth/user-example/callback")).toBe(true);
    expect(isValidRedirectUri("vscode://vscode.github-authentication/did-authenticate")).toBe(true);
    expect(isValidRedirectUri("com.example.app:/oauth2redirect")).toBe(true);
    for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:msgbox(1)", "blob:https://a.com/x"]) {
      expect(isValidRedirectUri(bad), bad).toBe(false);
    }
  });

  it("rejects fragments, user info, whitespace and overly long URIs", () => {
    expect(isValidRedirectUri("https://a.com/cb#x")).toBe(false);
    expect(isValidRedirectUri("https://a.com/cb#")).toBe(false);
    expect(isValidRedirectUri("https://user:pass@a.com/cb")).toBe(false);
    expect(isValidRedirectUri("https://a.com/c b")).toBe(false);
    expect(isValidRedirectUri("https://a.com/c\tb")).toBe(false);
    expect(isValidRedirectUri(`https://a.com/${"x".repeat(1990)}`)).toBe(false);
    expect(isValidRedirectUri(`https://a.com/${"x".repeat(1900)}`)).toBe(true);
    expect(isValidRedirectUri("")).toBe(false);
    expect(isValidRedirectUri(42)).toBe(false);
  });

  it("accepts 1 to 10 URIs and removes duplicates", () => {
    expect(validateRedirectUris([])).toHaveProperty("error");
    expect(validateRedirectUris("https://a.com/cb")).toHaveProperty("error");
    expect(validateRedirectUris(Array.from({ length: 11 }, (_, i) => `https://a.com/${i}`))).toHaveProperty("error");
    expect(validateRedirectUris(["https://a.com/cb", "javascript:x"])).toHaveProperty("error");
    expect(validateRedirectUris(["https://a.com/cb", "https://a.com/cb", "http://localhost/cb"])).toEqual({ uris: ["https://a.com/cb", "http://localhost/cb"] });
  });

  it("matches exactly; only loopback ports are free (RFC 8252 §7.3)", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback", "http://127.0.0.1:5000/cb?x=1", "cursor://anysphere.cursor-retrieval/oauth/cb"];
    expect(matchRedirectUri(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(matchRedirectUri(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(matchRedirectUri(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(matchRedirectUri(registered, "https://claude.ai:8443/api/mcp/auth_callback")).toBe(false);
    expect(matchRedirectUri(registered, "http://localhost:53124/callback")).toBe(true);
    expect(matchRedirectUri(registered, "http://localhost/callback")).toBe(true);
    expect(matchRedirectUri(registered, "http://localhost:53124/other")).toBe(false);
    expect(matchRedirectUri(registered, "http://127.0.0.1:53124/callback")).toBe(false);
    expect(matchRedirectUri(registered, "http://127.0.0.1:9/cb?x=1")).toBe(true);
    expect(matchRedirectUri(registered, "http://127.0.0.1:9/cb?x=2")).toBe(false);
    expect(matchRedirectUri(registered, "cursor://anysphere.cursor-retrieval/oauth/cb")).toBe(true);
    expect(matchRedirectUri(registered, "cursor://anysphere.cursor-retrieval/oauth/cb2")).toBe(false);
    expect(matchRedirectUri(registered, "javascript:alert(1)")).toBe(false);
  });

  it("adds parameters and keeps the existing query", () => {
    expect(buildRedirectUrl("https://a.com/cb?x=1", { code: "mcp_ac_1", state: "s t", iss: "https://auth.example.com" })).toBe(
      "https://a.com/cb?x=1&code=mcp_ac_1&state=s+t&iss=https%3A%2F%2Fauth.example.com",
    );
    expect(buildRedirectUrl("cursor://x.y/cb", { error: "access_denied", state: null })).toBe("cursor://x.y/cb?error=access_denied");
  });

  it("describes the destination for the consent screen", () => {
    expect(describeRedirectUri("https://claude.ai/api/mcp/auth_callback")).toEqual({ kind: "https", display: "claude.ai" });
    expect(describeRedirectUri("http://localhost:1234/cb")).toEqual({ kind: "loopback", display: "localhost" });
    expect(describeRedirectUri("cursor://anysphere.cursor-retrieval/oauth/cb")).toEqual({ kind: "custom_scheme", display: "cursor://" });
  });
});

describe("scope", () => {
  it("drops unknown scopes, keeps the configured order, falls back when empty", () => {
    expect(parseScope("mcp:read", SCOPES, SCOPES)).toEqual(["mcp:read"]);
    expect(parseScope("mcp:write  mcp:read mcp:read openid", SCOPES, SCOPES)).toEqual(["mcp:read", "mcp:write"]);
    expect(parseScope("", SCOPES, SCOPES)).toEqual(SCOPES);
    expect(parseScope("openid profile offline_access", SCOPES, ["mcp:read"])).toEqual(["mcp:read"]);
    expect(parseScope(undefined, SCOPES, SCOPES)).toEqual(SCOPES);
  });
});

describe("client name and URLs", () => {
  it("removes control and format characters and caps at 80 characters", () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    expect(sanitizeClientName("  Claude\n\tCode  ")).toBe("Claude Code");
    expect(sanitizeClientName(`Cl${zwsp}aude ${rlo}gpj.exe`)).toBe("Cl aude gpj.exe");
    expect(sanitizeClientName("x".repeat(200))).toHaveLength(80);
    expect(sanitizeClientName("   ")).toBeNull();
    expect(sanitizeClientName(null)).toBeNull();
  });

  it("client_uri and logo_uri must be https", () => {
    expect(sanitizeHttpsUrl("https://claude.ai")).toBe("https://claude.ai/");
    expect(sanitizeHttpsUrl("http://claude.ai")).toBeNull();
    expect(sanitizeHttpsUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("resource indicator (RFC 8707)", () => {
  const accepted = ["https://auth.example.com/mcp", "https://auth.example.com"];
  it("accepts only configured resources", () => {
    expect(isAcceptedResource("https://auth.example.com/mcp", accepted)).toBe(true);
    expect(isAcceptedResource("https://auth.example.com/mcp/", accepted)).toBe(true);
    expect(isAcceptedResource("https://auth.example.com", accepted)).toBe(true);
    expect(isAcceptedResource("https://auth.example.com/", accepted)).toBe(true);
    expect(isAcceptedResource("https://auth.example.com/other", accepted)).toBe(false);
    expect(isAcceptedResource("https://evil.example/mcp", accepted)).toBe(false);
    expect(isAcceptedResource("https://auth.example.com/mcp#x", accepted)).toBe(false);
    expect(isAcceptedResource("https://auth.example.com/mcp?x=1", accepted)).toBe(false);
  });
});

describe("error bodies, Basic auth and request bodies", () => {
  it("error_description is ASCII only", () => {
    expect(oauthErrorBody("invalid_grant")).toEqual({ error: "invalid_grant" });
    expect(oauthErrorBody("invalid_request", 'Code geçersiz "x" \\ y')).toEqual({ error: "invalid_request", error_description: "Code geersiz x  y" });
  });

  it("decodes Basic credentials with form encoding", () => {
    const b = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
    expect(parseBasicAuth(b("mcp_ci_1:mcp_cs_2"))).toEqual({ clientId: "mcp_ci_1", clientSecret: "mcp_cs_2" });
    expect(parseBasicAuth(b("a%3Ab:c%2Bd+e"))).toEqual({ clientId: "a:b", clientSecret: "c+d e" });
    expect(parseBasicAuth(b("only-id"))).toBe("malformed");
    expect(parseBasicAuth("Basic !!!")).toBe("malformed");
    expect(parseBasicAuth("Bearer mcp_at_x")).toBeNull();
    expect(parseBasicAuth(null)).toBeNull();
  });

  it("reads form and JSON bodies and rejects repeated parameters", async () => {
    const form = new Request("https://x/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=abc&redirect_uri=https%3A%2F%2Fa.com%2Fcb",
    });
    expect({ ...(await readOAuthParams(form, 1000)) }).toEqual({ grant_type: "authorization_code", code: "abc", redirect_uri: "https://a.com/cb" });
    const json = new Request("https://x/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "r", extra: { x: 1 } }),
    });
    expect({ ...(await readOAuthParams(json, 1000)) }).toEqual({ grant_type: "refresh_token", refresh_token: "r" });
    await expect(readOAuthParams(new Request("https://x/token", { method: "POST", body: "code=a&code=b" }), 1000)).rejects.toBeInstanceOf(OAuthError);
    await expect(readOAuthParams(new Request("https://x/token", { method: "POST", body: "x=".padEnd(2000, "a") }), 1000)).rejects.toMatchObject({ status: 413 });
  });
});

describe("dynamic client registration (RFC 7591)", () => {
  it("needs only redirect_uris; defaults to none and the redirect host as name", () => {
    const r = validateRegistration({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }, SCOPES, SCOPES);
    expect(r).toMatchObject({ ok: true, info: { authMethod: "none", name: "claude.ai", grantTypes: ["authorization_code", "refresh_token"], scope: null } });
  });

  it("handles a typical connector request", () => {
    const r = validateRegistration(
      {
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "mcp:read mcp:write",
      },
      SCOPES,
      SCOPES,
    );
    expect(r).toMatchObject({ ok: true, info: { name: "Claude", authMethod: "none", scope: "mcp:read mcp:write" } });
  });

  it("accepts secret methods and rejects others", () => {
    expect(validateRegistration({ redirect_uris: ["https://a.com/cb"], token_endpoint_auth_method: "client_secret_basic" }, SCOPES, SCOPES)).toMatchObject({
      ok: true,
      info: { authMethod: "client_secret_basic" },
    });
    expect(validateRegistration({ redirect_uris: ["https://a.com/cb"], token_endpoint_auth_method: "private_key_jwt" }, SCOPES, SCOPES)).toMatchObject({
      ok: false,
      code: "invalid_client_metadata",
    });
  });

  it("maps bad redirects to invalid_redirect_uri and drops unsupported grant types", () => {
    expect(validateRegistration({}, SCOPES, SCOPES)).toMatchObject({ ok: false, code: "invalid_redirect_uri" });
    expect(validateRegistration({ redirect_uris: ["http://evil.example/cb"] }, SCOPES, SCOPES)).toMatchObject({ ok: false, code: "invalid_redirect_uri" });
    expect(validateRegistration(null, SCOPES, SCOPES)).toMatchObject({ ok: false, code: "invalid_client_metadata" });
    expect(validateRegistration({ redirect_uris: ["https://a.com/cb"], grant_types: ["authorization_code", "client_credentials"] }, SCOPES, SCOPES)).toMatchObject({
      ok: true,
      info: { grantTypes: ["authorization_code"] },
    });
    expect(validateRegistration({ redirect_uris: ["https://a.com/cb"], grant_types: ["client_credentials"] }, SCOPES, SCOPES)).toMatchObject({ ok: false });
    expect(validateRegistration({ redirect_uris: ["https://a.com/cb"], response_types: ["token"] }, SCOPES, SCOPES)).toMatchObject({ ok: false });
  });
});

describe("Client ID Metadata Document rules", () => {
  const url = "https://client.example/oauth/client-metadata.json";

  it("URL rules", () => {
    expect(isClientMetadataDocumentUrl(url)).toBe(true);
    expect(isClientMetadataDocumentUrl("https://a.com/")).toBe(false);
    expect(isClientMetadataDocumentUrl("http://a.com/x.json")).toBe(false);
    expect(isClientMetadataDocumentUrl("https://a.com:8443/x.json")).toBe(false);
    expect(isClientMetadataDocumentUrl("https://a.com/x.json#y")).toBe(false);
    expect(isClientMetadataDocumentUrl("https://a.com/x/../y.json")).toBe(false);
    expect(isClientMetadataDocumentUrl("https://a.com/x/%2e%2e/y.json")).toBe(false);
    expect(isClientMetadataDocumentUrl("https://u:p@a.com/x.json")).toBe(false);
    expect(isClientMetadataDocumentUrl("https://A.com/x.json")).toBe(false);
    expect(isClientMetadataDocumentUrl("mcp_ci_abc")).toBe(false);
  });

  it("document validation", () => {
    const doc = { client_id: url, client_name: "Example Editor", redirect_uris: ["http://127.0.0.1:33418/", "https://client.example/redirect"] };
    expect(validateClientMetadataDocument(doc, url)).toMatchObject({ name: "Example Editor", redirectUris: doc.redirect_uris });
    expect(validateClientMetadataDocument({ ...doc, client_id: "https://evil.example/x.json" }, url)).toHaveProperty("error");
    expect(validateClientMetadataDocument({ ...doc, client_secret: "x" }, url)).toHaveProperty("error");
    expect(validateClientMetadataDocument({ ...doc, token_endpoint_auth_method: "private_key_jwt" }, url)).toHaveProperty("error");
    expect(validateClientMetadataDocument({ ...doc, redirect_uris: ["javascript:x"] }, url)).toHaveProperty("error");
    expect(validateClientMetadataDocument({ ...doc, client_name: undefined }, url)).toMatchObject({ name: "client.example" });
    expect(validateClientMetadataDocument([], url)).toHaveProperty("error");
  });
});

describe("consent token", () => {
  const secret = "test-secret-at-least-thirty-two-bytes-long";
  const payload: ConsentPayload = {
    u: "user-1",
    c: "mcp_ci_abc",
    r: "https://claude.ai/api/mcp/auth_callback",
    ch: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    s: "mcp:read mcp:write",
    st: "state-çğü",
    rs: "https://auth.example.com/mcp",
    i: "https://auth.example.com",
    t: 1_000_000,
  };

  it("round-trips; tampered or foreign-key tokens are rejected", () => {
    const token = signConsentToken(payload, secret);
    expect(verifyConsentToken(token, secret)).toEqual(payload);
    expect(verifyConsentToken(token, `${secret}x`)).toBeNull();
    const [data, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...payload, r: "https://evil.example/cb" })).toString("base64url");
    expect(verifyConsentToken(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifyConsentToken(`${data}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, secret)).toBeNull();
    expect(verifyConsentToken("broken", secret)).toBeNull();
    expect(verifyConsentToken(undefined, secret)).toBeNull();
  });

  it("is fresh for the configured lifetime", () => {
    const ttl = 15 * 60_000;
    expect(isConsentFresh(payload, payload.t + 14 * 60_000, ttl)).toBe(true);
    expect(isConsentFresh(payload, payload.t + 16 * 60_000, ttl)).toBe(false);
    expect(isConsentFresh(payload, payload.t - 5 * 60_000, ttl)).toBe(false);
  });

  it("rebuilds the authorization query", () => {
    expect(Object.fromEntries(new URLSearchParams(authorizationQueryFromConsent(payload)))).toEqual({
      response_type: "code",
      client_id: payload.c,
      redirect_uri: payload.r,
      code_challenge: payload.ch,
      code_challenge_method: "S256",
      scope: payload.s,
      state: payload.st,
      resource: payload.rs,
    });
  });
});
