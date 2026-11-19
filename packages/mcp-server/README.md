# @klakix/mcp-server

A stateless [Model Context Protocol](https://modelcontextprotocol.io) server core for any runtime that speaks the Web Fetch API (`Request` in, `Response` out). It implements the Streamable HTTP transport with plain JSON responses and gives you:

- tools with [zod](https://zod.dev) schemas, converted to JSON Schema for `tools/list`;
- prompts and text resources;
- hooks for authentication, authorization, rate limiting and call logging;
- tool scopes (`insufficient_scope` errors when the caller lacks a permission);
- `fetchRemoteMedia`, a media downloader that refuses to reach private networks (SSRF protection), for tools that accept file URLs.

One runtime dependency (`zod`). No framework, no Node-only APIs in the request path. Node.js 20 or newer for local use; any runtime with the Web Fetch API works.

```sh
npm install @klakix/mcp-server zod
```

## Quick start

```ts
import { z } from "zod";
import { createMcpHandler, defineTool, toolOk } from "@klakix/mcp-server";

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Repeat a message back to the caller.",
  inputSchema: z.object({ message: z.string().describe("Text to repeat") }),
  annotations: { readOnlyHint: true },
  handler: ({ message }) => toolOk(`You said: ${message}`, { message }),
});

export const mcp = createMcpHandler({
  serverInfo: { name: "example", version: "1.0.0" },
  instructions: "Call echo to repeat text.",
  tools: [echo],
  authenticate: async (request) => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /i, "");
    return token === process.env.MCP_TOKEN ? { scopes: new Set(["read"]) } : null;
  },
});

// mcp.handle(request) -> Promise<Response>
```

## Mounting it

### Next.js route handler

```ts
// app/mcp/route.ts
import { mcp } from "@/lib/mcp";

export const POST = (request: Request) => mcp.handle(request);
export const GET = POST;
export const DELETE = POST;
export const OPTIONS = POST;
```

`GET` and `DELETE` answer `405` (the transport is stateless), `OPTIONS` answers CORS preflight. To run the `onToolCall` hook after the response, pass `waitUntil: (p) => after(() => p)` when creating the handler.

### Node `http`

```ts
import { createServer } from "node:http";
import { Readable } from "node:stream";

createServer(async (req, res) => {
  const url = `http://${req.headers.host}${req.url}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
  const response = await mcp.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(3000);
```

### Hono

```ts
import { Hono } from "hono";

const app = new Hono();
app.all("/mcp", (c) => mcp.handle(c.req.raw));
export default app;
```

### Cloudflare Workers

```ts
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const mcp = createMcpHandler({
      /* ... */
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
    return mcp.handle(request);
  },
};
```

Build the handler per request only if it depends on `env`; otherwise create it once at module level.

## Defining things

### Tools

```ts
const search = defineTool({
  name: "search_notes",
  description: "Full text search over the user's notes.",
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().max(50).default(10) }),
  scope: "notes:read",
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ query, limit }, ctx) {
    const hits = await db.search(ctx.principal.userId, query, limit);
    return toolOk(`Found ${hits.length} notes.`, { hits }, [], { resultCount: hits.length });
  },
});
```

- Arguments are validated with `inputSchema` before the handler runs. A failure becomes a tool error (`invalid_arguments`) listing every bad field, so the model can fix the call. It is not a JSON-RPC error.
- `toolOk(summary, data?, extraContent?, meta?)` sends the summary and the JSON as text and `data` as `structuredContent`. `extraContent` takes image, audio and `resource_link` parts.
- `toolError(code, message, extra?, meta?)` returns `isError: true` with a machine readable code. Use it for conditions the model can act on (out of quota, not found, blocked input).
- `meta` is a server side record. It is never sent to the client; it arrives in `onToolCall`. Put anything you need for logging or billing there.
- A thrown exception becomes a generic `internal_error` that leaks nothing. Map your own error classes with `onToolError`.
- `forPrincipal<MyPrincipal>()` returns `defineTool`, `definePrompt` and `defineResource` with `ctx.principal` typed.

### Prompts and resources

```ts
const review = definePrompt({
  name: "review_text",
  title: "Review text",
  description: "Ask for an edit pass.",
  arguments: [{ name: "text", description: "The text to review", required: true }],
  render: ({ text }) => `Review the following text and suggest edits:\n\n${text}`,
});

const style = defineResource({
  uri: "docs://style-guide",
  name: "style-guide",
  mimeType: "text/markdown",
  read: () => "# Style guide\n...",
});
```

Missing required prompt arguments are rejected with JSON-RPC error `-32602`. Argument values are cut to 4000 characters.

## Hooks

| Option | Purpose |
| --- | --- |
| `authenticate(request)` | Return your principal, or `null` for `401`. Required. |
| `wwwAuthenticate(request, error?)` | Value of the `WWW-Authenticate` header on `401`. `error` is `"invalid_token"` when credentials were sent but rejected. |
| `authorize(principal, request)` | Return a `Response` to stop the request (suspended account, closed beta), or `null`. CORS headers are added to it. |
| `rateLimit(principal, toolName)` | Return seconds to wait, or `null`. The tool call becomes a `rate_limited` tool error. |
| `onToolCall(event)` | After each tool call: `tool`, `ok`, `errorCode`, `durationMs`, `principal`, `meta`, `request`. Errors thrown here are swallowed. |
| `onToolError(error, info)` | Map thrown errors to a `ToolResult`, or log them. |
| `waitUntil(promise)` | Run `onToolCall` in the background on serverless platforms. |
| `maxBodyBytes` | Request size limit, default 10 MiB. Larger bodies get `413`. |
| `cors` | `true` (default), `false`, or an object that overrides individual headers. |
| `protocolVersions` | Newest first. Default `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. |

A tool with `scope: "x"` is callable only when `principal.scopes` contains `"x"`. A principal without `scopes` holds none.

## Fetching media from URLs safely

```ts
import { fetchRemoteMedia, MediaFetchError } from "@klakix/mcp-server";

try {
  const { bytes, mimeType, size } = await fetchRemoteMedia(input.imageUrl, {
    expected: "image",
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 20_000,
  });
  // store bytes, hand them to a model, ...
} catch (error) {
  if (error instanceof MediaFetchError) return toolError(error.code, error.message);
  throw error;
}
```

What it enforces:

- `http:` and `https:` only; credentials in the URL are refused.
- The host must resolve to public addresses only. Loopback, RFC 1918, link-local (including cloud metadata at `169.254.169.254`), carrier-grade NAT, multicast and reserved ranges are blocked, as are IPv6 forms that wrap them (IPv4-mapped, NAT64, 6to4, unique-local). Names such as `localhost`, `*.local` and `*.internal` are refused outright. If a name resolves to several addresses, all of them must be public.
- Redirects are followed manually, at most `maxRedirects` (default 3), and every hop goes through the same checks.
- The body is streamed and cancelled as soon as it passes `maxBytes`; `Content-Length` is checked first.
- The type comes from the file's magic bytes. The `Content-Type` header is ignored, SVG is rejected, and `expected` pins the kind.

Error codes: `invalid_url`, `blocked_address`, `dns_failed`, `http_error`, `download_failed`, `too_large`, `too_many_redirects`, `unsupported_type`, `timeout`.

DNS resolution and the HTTP connection are two lookups by default, which leaves a small DNS rebinding window. Where that matters, pass a `fetch` that pins the connection to the addresses that were validated; it receives them as its third argument:

```ts
import { Agent } from "undici";

const pinned = (url: URL, init: RequestInit, resolved: { addresses: readonly string[] }) => {
  const address = resolved.addresses[0]!;
  const dispatcher = new Agent({
    connect: { lookup: (_host, _opts, cb) => cb(null, address, address.includes(":") ? 6 : 4) },
  });
  return fetch(url, { ...init, dispatcher } as RequestInit);
};

await fetchRemoteMedia(url, { maxBytes: 5_000_000, fetch: pinned });
```

For tests, inject `resolveHost` and `fetch` to run without a network.

## Using it with `@klakix/mcp-oauth`

MCP clients that support authorization discover your authorization server from the `WWW-Authenticate` header of a `401`. [`@klakix/mcp-oauth`](../mcp-oauth) provides the OAuth 2.1 endpoints (metadata, dynamic client registration, authorization code with PKCE, token) and the token verification. Pass `oauth.authenticate` the incoming request in `authenticate`, and let `oauth.wwwAuthenticate` build the header for `wwwAuthenticate`.

```sh
npm install @klakix/mcp-server @klakix/mcp-oauth zod
```

```ts
import { createMcpHandler } from "@klakix/mcp-server";
import { createOAuthServer, MemoryStore } from "@klakix/mcp-oauth";

const oauth = createOAuthServer({
  issuer: "https://example.com",
  resource: "https://example.com/mcp",
  scopes: [
    { name: "mcp:read", description: "Read your data" },
    { name: "mcp:write", description: "Create and change data" },
  ],
  store: new MemoryStore(), // use your own OAuthStore in production
  secret: process.env.OAUTH_CONSENT_SECRET!, // at least 32 bytes
});

export const mcp = createMcpHandler({
  serverInfo: { name: "my-server", version: "1.0.0" },
  tools,
  authenticate: async (request) => {
    const grant = await oauth.authenticate(request); // reads and verifies the Bearer token
    return grant ? { userId: grant.userId, scopes: new Set(grant.scopes) } : null;
  },
  wwwAuthenticate: (_request, error) => oauth.wwwAuthenticate(error),
});
```

`oauth.authenticate` returns `{ userId, clientId, scopes, grantId, resource, expiresAt }` or `null` for an unknown, expired or revoked token. The scopes granted at consent time become `principal.scopes`, so a read-only connection cannot call tools that declare a write scope.

The OAuth endpoints, the metadata routes and the consent page are mounted by your application; see the [`@klakix/mcp-oauth` README](../mcp-oauth#readme). A complete working server that wires both packages together is in [`examples/self-hosted`](../../examples/self-hosted).

## Why stateless JSON

The Streamable HTTP transport allows a server to answer with an SSE stream and to keep sessions. This package does neither, on purpose:

- every request is self-contained (the bearer token identifies the caller), so any instance can serve any request and there is nothing to expire, evict or replicate;
- plain JSON works on serverless platforms with short request limits and behind proxies that buffer or cut streams;
- tools that run long should return a job id and offer a polling tool, which also survives client reconnects.

The cost: no server-initiated messages (sampling, elicitation, progress notifications, list-changed). If your server needs them, use a stateful transport.

## Behavior reference

- `POST` carries one JSON-RPC message or a batch. Requests get `200` with JSON, notifications and client responses get `202` with no body.
- Errors: `-32700` parse error (HTTP 400), `-32600` invalid request, `-32601` unknown method, `-32602` unknown tool, prompt or bad prompt arguments, `-32002` resource not found, `-32603` a prompt or resource threw.
- `401` carries `WWW-Authenticate`; `405` carries `Allow: POST, OPTIONS`; `413` is returned for oversized bodies.
- Capabilities are advertised only for the kinds you register (tools, prompts, resources). `resources/templates/list` always returns an empty list.

## License

MIT
