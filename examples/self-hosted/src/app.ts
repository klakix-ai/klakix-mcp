import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createOAuthServer, MemoryStore, type OAuthServer, type OAuthStore } from "@klakix/mcp-oauth";
import { createMcpHandler, type McpHandler } from "@klakix/mcp-server";
import { renderImageSvg, type AspectRatio } from "./art.ts";
import { DemoBackend, type GenerationBackend } from "./backend.ts";
import { consentPage, errorPage, homePage, HTML_HEADERS } from "./pages.ts";
import { createTools, productAdPrompt, promptingGuide, SCOPE_GENERATE, SCOPE_READ, type DemoPrincipal } from "./tools.ts";

/** The single built-in account of this example. Replace it with your own session handling. */
const DEMO_USER_ID = "demo-user";
const DEMO_USER_LABEL = "demo";
const MAX_FORM_BYTES = 16 * 1024;

export interface AppOptions {
  /** Public origin of this server, for example `http://localhost:8787` or `https://mcp.example.com`. */
  issuer: string;
  /** HMAC key for consent tokens, at least 32 bytes. Random per process when omitted. */
  consentSecret?: string;
  /** When set, `Authorization: Bearer <apiKey>` is accepted on `/mcp` with full access. */
  apiKey?: string;
  /** OAuth persistence. Defaults to an in-memory store; use a database in production. */
  store?: OAuthStore;
  /** Generation backend. Defaults to the demo backend that calls no external service. */
  backend?: GenerationBackend;
  /** Duration of a fake video job in the demo backend. Default 6000 ms. */
  videoDelayMs?: number;
  /** Receives one line per tool call. Default `console.log`. */
  log?: (line: string) => void;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  oauth: OAuthServer;
  mcp: McpHandler;
  backend: GenerationBackend;
}

function sameSecret(a: string, b: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

function redirect(location: string, status: 302 | 303): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_FORM_BYTES || !request.body) return declared > MAX_FORM_BYTES ? null : new URLSearchParams();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function createApp(options: AppOptions): App {
  const issuer = options.issuer.replace(/\/+$/, "");
  const origin = new URL(issuer).origin;
  const consentSecret = options.consentSecret ?? randomBytes(32).toString("hex");
  const backend = options.backend ?? new DemoBackend({ baseUrl: issuer, ...(options.videoDelayMs === undefined ? {} : { videoDelayMs: options.videoDelayMs }) });

  const log = options.log ?? ((line: string) => console.log(line));

  const oauth = createOAuthServer({
    issuer,
    resource: `${issuer}/mcp`,
    resourceName: "Klakix MCP self-hosted example",
    scopes: [
      { name: SCOPE_READ, description: "See your account and the status of your generations" },
      { name: SCOPE_GENERATE, description: "Create images and videos" },
    ],
    store: options.store ?? new MemoryStore(),
    secret: consentSecret,
    dynamicClientRegistration: true,
    clientIdMetadataDocuments: true,
  });

  const mcp = createMcpHandler<DemoPrincipal>({
    serverInfo: { name: "klakix-mcp-self-hosted", title: "Self-hosted MCP example", version: "0.1.0" },
    instructions:
      "Demo generation server. generate_image returns an image at once. generate_video starts a job; poll it with get_generation (wait_seconds lets the call wait). get_account shows the credit balance. Nothing here calls a paid service.",
    tools: createTools(backend),
    prompts: [productAdPrompt],
    resources: [promptingGuide],
    async authenticate(request) {
      const header = request.headers.get("authorization") ?? "";
      const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (bearer && options.apiKey && sameSecret(bearer, options.apiKey)) {
        return { userId: DEMO_USER_ID, scopes: new Set([SCOPE_READ, SCOPE_GENERATE]), via: "api_key" };
      }
      const grant = await oauth.authenticate(request);
      if (!grant) return null;
      return { userId: grant.userId, scopes: new Set(grant.scopes), via: "oauth", clientId: grant.clientId };
    },
    wwwAuthenticate: (_request, error) => oauth.wwwAuthenticate(error),
    onToolCall: (event) => {
      log(`tool ${event.tool} ${event.ok ? "ok" : `failed (${event.errorCode ?? "error"})`} ${event.durationMs}ms user=${event.principal.userId}`);
    },
  });

  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const path = (url: string) => new URL(url, origin).pathname;
  for (const p of oauth.wellKnownPaths.authorizationServer) routes.set(p, oauth.authorizationServerMetadata);
  for (const p of oauth.wellKnownPaths.protectedResource) routes.set(p, oauth.protectedResourceMetadata);
  routes.set(path(oauth.endpoints.registration), oauth.register);
  routes.set(path(oauth.endpoints.token), oauth.token);
  routes.set(path(oauth.endpoints.revocation), oauth.revoke);
  routes.set("/mcp", (request) => mcp.handle(request));

  const authorizePath = path(oauth.endpoints.authorization);

  /** Shows the consent screen. The demo user is always signed in; a real app checks its session here. */
  async function showConsent(url: URL): Promise<Response> {
    const result = await oauth.authorize.parse(url.searchParams, DEMO_USER_ID);
    if (!result.ok) {
      if (result.type === "redirect") return redirect(result.redirectTo, 302);
      // The client or redirect URI is not trusted: never redirect.
      return html(errorPage(result.description), 400);
    }
    return html(
      consentPage({
        clientName: result.client.name,
        clientUri: result.client.clientUri,
        registrationType: result.client.registrationType,
        redirectDisplay: result.redirect.display,
        scopes: result.scopes,
        consentToken: result.consentToken ?? "",
        userLabel: DEMO_USER_LABEL,
        action: authorizePath,
      }),
    );
  }

  async function decide(request: Request): Promise<Response> {
    // Browsers always send Origin on form posts; refuse anything cross-origin.
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin && requestOrigin !== origin) return html(errorPage("The request came from another site."), 403);

    const form = await readForm(request);
    if (!form) return html(errorPage("The form is too large."), 413);
    const token = form.get("consent");
    const result = form.get("decision") === "approve" ? await oauth.authorize.approve(token, DEMO_USER_ID) : await oauth.authorize.deny(token);
    if (result.ok) return redirect(result.redirectTo, 303);
    // Expired or changed: show the consent screen again. A bad token has nothing to show.
    if (result.authorizationQuery) return redirect(`${authorizePath}?${result.authorizationQuery}`, 303);
    return html(errorPage("The consent form is not valid. Start the connection again."), 400);
  }

  function imageFile(url: URL): Response {
    const prompt = (url.searchParams.get("p") ?? "").slice(0, 1000) || "demo";
    const ar = url.searchParams.get("ar");
    const aspectRatio: AspectRatio = ar === "16:9" || ar === "9:16" ? ar : "1:1";
    return new Response(renderImageSvg(prompt, aspectRatio), {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    const handler = routes.get(url.pathname);
    if (handler) return handler(request);

    if (url.pathname === authorizePath) {
      if (method === "GET" || method === "HEAD") return showConsent(url);
      if (method === "POST") return decide(request);
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
    }
    if (url.pathname === "/files/image.svg" && (method === "GET" || method === "HEAD")) return imageFile(url);
    if (url.pathname === "/" && (method === "GET" || method === "HEAD")) return html(homePage(issuer));
    return new Response("Not found", { status: 404 });
  }

  return {
    oauth,
    mcp,
    backend,
    async fetch(request) {
      try {
        return await route(request);
      } catch (error) {
        console.error("unhandled error", error);
        return new Response("Internal server error", { status: 500 });
      }
    },
  };
}

/* ---------------- node:http adapter ---------------- */

function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method ?? "GET",
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response, headOnly: boolean): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (headOnly || !response.body) return void res.end();
  res.end(Buffer.from(await response.arrayBuffer()));
}

export interface StartOptions extends Omit<AppOptions, "issuer"> {
  /** Defaults to `http://localhost:<port>`. */
  issuer?: string;
  /** Default 8787. Use 0 for a random free port. */
  port?: number;
  /** Interface to bind. Default `127.0.0.1`. */
  host?: string;
}

export interface RunningServer {
  server: Server;
  app: App;
  issuer: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const issuer = (options.issuer ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const { issuer: _issuer, port: _port, host: _host, ...appOptions } = options;
  const app = createApp({ ...appOptions, issuer });
  const origin = new URL(issuer).origin;

  server.on("request", (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    app
      .fetch(toRequest(req, origin, abort.signal))
      .then((response) => send(res, response, req.method === "HEAD"))
      .catch((error: unknown) => {
        console.error("response error", error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });

  return {
    server,
    app,
    issuer,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
