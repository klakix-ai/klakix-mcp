import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCodeChallenge } from "@klakix/mcp-oauth";
import { startServer, type RunningServer } from "../src/app.ts";

const REDIRECT = "http://127.0.0.1:9/callback";
const API_KEY = "demo-api-key-for-tests";

let running: RunningServer;
let base: string;

beforeAll(async () => {
  // Port 0 picks a free port; the issuer defaults to http://localhost:<port>, which is what MCP clients see.
  running = await startServer({
    port: 0,
    consentSecret: "test-secret-with-at-least-thirty-two-bytes",
    apiKey: API_KEY,
    videoDelayMs: 600,
    log: () => undefined,
  });
  base = running.issuer;
});

afterAll(async () => {
  await running.close();
});

interface Session {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function form(params: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(), redirect: "manual" };
}

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "E2E client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  });
  expect(response.status).toBe(201);
  const body = await json(response);
  expect(body.client_id).toBeTypeOf("string");
  return body.client_id as string;
}

/** Runs the authorization request up to the consent screen and returns its signed token. */
async function openConsent(clientId: string, challenge: string, scope: string): Promise<{ consent: string; page: Response; state: string }> {
  const state = randomBytes(8).toString("hex");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state,
    resource: `${base}/mcp`,
  });
  const page = await fetch(`${base}/oauth/authorize?${query}`, { redirect: "manual" });
  expect(page.status).toBe(200);
  const text = await page.clone().text();
  const consent = /name="consent" value="([^"]+)"/.exec(text)?.[1];
  expect(consent, "consent token in the page").toBeTruthy();
  return { consent: consent as string, page, state };
}

async function signIn(scope: string): Promise<Session> {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const { consent, state } = await openConsent(clientId, computeCodeChallenge(verifier), scope);

  const decision = await fetch(`${base}/oauth/authorize`, form({ consent, decision: "approve" }));
  expect(decision.status).toBe(303);
  const location = new URL(decision.headers.get("location") as string);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe(state);
  expect(location.searchParams.get("iss")).toBe(base);
  const code = location.searchParams.get("code") as string;
  expect(code).toBeTruthy();

  const wrong = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: randomBytes(32).toString("base64url") }));
  expect(wrong.status).toBe(400);
  expect((await json(wrong)).error).toBe("invalid_grant");

  const tokenResponse = await fetch(
    `${base}/oauth/token`,
    form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${base}/mcp` }),
  );
  expect(tokenResponse.status).toBe(200);
  const token = await json(tokenResponse);
  expect(token.token_type).toBe("Bearer");
  return { clientId, accessToken: token.access_token, refreshToken: token.refresh_token, scope: token.scope };
}

let nextId = 1;

async function rpc(token: string | null, method: string, params?: Record<string, unknown>): Promise<{ response: Response; body: Record<string, any> | null }> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const { response, body } = await rpc(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  expect(body?.error).toBeUndefined();
  return body?.result as Record<string, any>;
}

describe("self-hosted example", () => {
  it("runs the whole OAuth and MCP flow over HTTP", async () => {
    // 1. Protected resource metadata is public.
    const resourceMetadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(resourceMetadata.status).toBe(200);
    const resource = await json(resourceMetadata);
    expect(resource.resource).toBe(`${base}/mcp`);
    expect(resource.authorization_servers).toContain(base);
    expect(resource.scopes_supported).toEqual(["mcp:read", "mcp:generate"]);

    const asMetadata = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
    expect(asMetadata.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(asMetadata.code_challenge_methods_supported).toContain("S256");

    // 2. No token: 401 that points to the metadata.
    const anonymous = await rpc(null, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const garbage = await rpc("mcp_at_not-a-real-token", "tools/list");
    expect(garbage.response.status).toBe(401);
    expect(garbage.response.headers.get("www-authenticate")).toContain('error="invalid_token"');

    // 3. Registration, consent, code, token with PKCE.
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const { consent, page } = await openConsent(clientId, computeCodeChallenge(verifier), "mcp:read mcp:generate");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const consentHtml = await page.text();
    expect(consentHtml).toContain("E2E client");
    expect(consentHtml).toContain("Create images and videos");

    const decision = await fetch(`${base}/oauth/authorize`, form({ consent, decision: "approve" }));
    expect(decision.status).toBe(303);
    const code = new URL(decision.headers.get("location") as string).searchParams.get("code") as string;
    const tokenResponse = await fetch(
      `${base}/oauth/token`,
      form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${base}/mcp` }),
    );
    expect(tokenResponse.status).toBe(200);
    const token = await json(tokenResponse);
    expect(token.scope).toBe("mcp:read mcp:generate");

    // 4. MCP session setup and discovery.
    const accessToken = token.access_token as string;
    const init = await rpc(accessToken, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    expect(init.response.status).toBe(200);
    expect(init.body?.result.serverInfo.name).toBe("klakix-mcp-self-hosted");
    expect(init.body?.result.capabilities.tools).toBeDefined();
    const notified = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notified.status).toBe(202);

    const tools = await rpc(accessToken, "tools/list");
    expect(tools.body?.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["generate_image", "generate_video", "get_account", "get_generation"]);
    const prompts = await rpc(accessToken, "prompts/list");
    expect(prompts.body?.result.prompts.map((p: { name: string }) => p.name)).toEqual(["product_ad"]);
    const guide = await rpc(accessToken, "resources/read", { uri: "docs://prompting-guide" });
    expect(guide.body?.result.contents[0].text).toContain("Prompting guide");

    // 5. generate_image: inline image plus a link that serves the same file.
    const image = await callTool(accessToken, "generate_image", { prompt: "a red bicycle on a quiet street", aspect_ratio: "16:9" });
    expect(image.isError).not.toBe(true);
    const inline = image.content.find((c: { type: string }) => c.type === "image");
    expect(inline.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(inline.data, "base64").toString("utf8")).toContain("<svg");
    const link = image.content.find((c: { type: string }) => c.type === "resource_link");
    const file = await fetch(link.uri);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/svg+xml");
    expect(await file.text()).toBe(Buffer.from(inline.data, "base64").toString("utf8"));

    // 6. generate_video is asynchronous; get_generation waits for it.
    const started = await callTool(accessToken, "generate_video", { prompt: "slow push-in on a lighthouse at dusk", duration_seconds: 4 });
    expect(started.structuredContent.status).toBe("queued");
    const generationId = started.structuredContent.generation_id as string;
    const early = await callTool(accessToken, "get_generation", { generation_id: generationId });
    expect(["queued", "processing"]).toContain(early.structuredContent.status);
    const done = await callTool(accessToken, "get_generation", { generation_id: generationId, wait_seconds: 10 });
    expect(done.structuredContent.status).toBe("completed");
    expect(done.structuredContent.progress).toBe(100);
    expect(done.content.some((c: { type: string; uri?: string }) => c.type === "resource_link" && c.uri?.endsWith(".mp4"))).toBe(true);
    const missing = await callTool(accessToken, "get_generation", { generation_id: "gen_does_not_exist" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe("not_found");

    const account = await callTool(accessToken, "get_account", {});
    expect(account.structuredContent.generations).toBe(2);
    expect(account.structuredContent.credits).toBe(200 - 1 - 4 * 2);
    expect(account.structuredContent.scopes).toEqual(["mcp:generate", "mcp:read"]);

    // 7. Refresh rotates both tokens; the old ones stop working.
    const refreshed = await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: clientId }));
    expect(refreshed.status).toBe(200);
    const next = await json(refreshed);
    expect(next.access_token).not.toBe(accessToken);
    expect((await rpc(accessToken, "tools/list")).response.status).toBe(401);
    expect((await rpc(next.access_token, "tools/list")).response.status).toBe(200);

    // 8. Revocation ends the connection.
    const revoked = await fetch(`${base}/oauth/revoke`, form({ token: next.refresh_token, client_id: clientId }));
    expect(revoked.status).toBe(200);
    const after = await rpc(next.access_token, "tools/list");
    expect(after.response.status).toBe(401);
    expect(after.response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("enforces the granted scope", async () => {
    const session = await signIn("mcp:read");
    expect(session.scope).toBe("mcp:read");
    const denied = await callTool(session.accessToken, "generate_image", { prompt: "a quiet harbor" });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error.code).toBe("insufficient_scope");
    const account = await callTool(session.accessToken, "get_account", {});
    expect(account.isError).not.toBe(true);
  });

  it("treats a replayed authorization code as theft and revokes the grant", async () => {
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const { consent } = await openConsent(clientId, computeCodeChallenge(verifier), "mcp:read");
    const decision = await fetch(`${base}/oauth/authorize`, form({ consent, decision: "approve" }));
    const code = new URL(decision.headers.get("location") as string).searchParams.get("code") as string;
    const exchange = () => fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }));

    const first = await exchange();
    expect(first.status).toBe(200);
    const accessToken = (await json(first)).access_token as string;
    expect((await rpc(accessToken, "tools/list")).response.status).toBe(200);

    expect((await exchange()).status).toBe(400);
    expect((await rpc(accessToken, "tools/list")).response.status).toBe(401);
  });

  it("returns access_denied when the user cancels", async () => {
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const { consent, state } = await openConsent(clientId, computeCodeChallenge(verifier), "mcp:read");
    const decision = await fetch(`${base}/oauth/authorize`, form({ consent, decision: "deny" }));
    expect(decision.status).toBe(303);
    const location = new URL(decision.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses a consent form posted from another origin and unknown redirect URIs", async () => {
    const clientId = await registerClient();
    const { consent } = await openConsent(clientId, computeCodeChallenge(randomBytes(32).toString("base64url")), "mcp:read");
    const crossSite = await fetch(`${base}/oauth/authorize`, { ...form({ consent, decision: "approve" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);

    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: computeCodeChallenge("x".repeat(43)), code_challenge_method: "S256" });
    const bad = await fetch(`${base}/oauth/authorize?${query}`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
  });

  it("accepts the demo API key as a bearer token", async () => {
    const account = await callTool(API_KEY, "get_account", {});
    expect(account.structuredContent.signed_in_with).toBe("api_key");
    const wrong = await rpc("not-the-key", "tools/list");
    expect(wrong.response.status).toBe(401);
  });
});
