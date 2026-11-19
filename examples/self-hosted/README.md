# Self-hosted example

A complete remote MCP server in a few hundred lines of TypeScript, built on [`@klakix/mcp-server`](../../packages/mcp-server) and [`@klakix/mcp-oauth`](../../packages/mcp-oauth). It uses Node's plain `http` module, so the code shows exactly where each piece connects.

What it does:

- OAuth 2.1 sign-in for MCP clients: protected resource and authorization server metadata, dynamic client registration, Client ID Metadata Documents, authorization code with PKCE, refresh token rotation and revocation.
- A consent page at `/oauth/authorize`, served with `frame-ancestors 'none'` and a same-origin check on the form post.
- The MCP endpoint at `/mcp`, with two ways in: an OAuth access token, or a fixed API key from `DEMO_API_KEY`.
- Four demo tools, one prompt and one resource. Nothing calls a paid service.

| Item | Scope | What it does |
| --- | --- | --- |
| `generate_image` | `mcp:generate` | Draws a deterministic SVG from the prompt. Returns it inline (image content) and as a `resource_link`. |
| `generate_video` | `mcp:generate` | Queues a fake job and returns a `generation_id` at once. |
| `get_generation` | `mcp:read` | Reports the job. `wait_seconds` (up to 30) waits for `completed`, which returns a link to a sample clip. |
| `get_account` | `mcp:read` | Credit balance, generation count and the permissions of this connection. |
| prompt `product_ad` | none | A template that plans an ad and calls the tools. |
| resource `docs://prompting-guide` | none | A short prompting guide. |

## Run it

From the repository root (Node.js 22.18 or newer, because the server runs TypeScript directly):

```sh
npm install
npm run build
npm start -w examples/self-hosted
```

Check that it is up:

```sh
curl http://localhost:8787/.well-known/oauth-protected-resource/mcp
```

Settings come from environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listening port. |
| `HOST` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` in a container. |
| `ISSUER` | `http://localhost:<PORT>` | Public origin of the server. Must be `https` unless it is localhost. |
| `OAUTH_CONSENT_SECRET` | random per start | HMAC key for consent tokens, at least 32 bytes. Set it when you run more than one instance. |
| `DEMO_API_KEY` | none | When set, `Authorization: Bearer <key>` is accepted on `/mcp` with full access. |

The example has one built-in account (`demo`), so the consent page needs no password. That is the part you replace with your own sign-in; see below.

## Connect with MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector window choose the transport "Streamable HTTP", enter `http://localhost:8787/mcp` and connect. Open the OAuth settings and run the guided flow (or press Connect and follow the redirect). The Inspector registers itself, sends you to the consent page, and returns with a token. Then open Tools and run `generate_image`, or `generate_video` followed by `get_generation` with `wait_seconds` set to 10.

To skip OAuth, start the server with `DEMO_API_KEY=secret` and add the header `Authorization: Bearer secret` in the Inspector's authentication panel.

## Connect with Claude Code

```sh
claude mcp add --transport http klakix-demo http://localhost:8787/mcp
```

Run `/mcp` inside Claude Code, pick `klakix-demo` and choose Authenticate. A browser tab opens on the consent page; press Allow. With an API key instead:

```sh
claude mcp add --transport http klakix-demo http://localhost:8787/mcp --header "Authorization: Bearer secret"
```

Then ask: "Use klakix-demo to make a 5 second video of a lighthouse at dusk and tell me when it is ready."

## How it is wired

| File | Role |
| --- | --- |
| `src/index.ts` | Reads the environment and starts the server. |
| `src/app.ts` | Routing, the `node:http` adapter, the consent flow (`authorize.parse`, `approve`, `deny`), and `createMcpHandler` with `authenticate` and `wwwAuthenticate`. |
| `src/tools.ts` | Tool, prompt and resource definitions. They only talk to `GenerationBackend`. |
| `src/backend.ts` | The `GenerationBackend` interface and the in-memory `DemoBackend`. |
| `src/pages.ts` | HTML for the consent and error pages, and the security headers. |
| `src/art.ts` | The placeholder SVG renderer. |
| `test/e2e.test.ts` | Starts the server on a random port and runs the full flow over HTTP. |

## Make it real

**Connect your generation backend.** Implement `GenerationBackend` from `src/backend.ts` (fal, Replicate, your own model server, any queue) and pass it to `startServer({ backend })` in `src/index.ts`. Four methods are all it needs:

- `generateImage` returns bytes (base64) and a public URL. Fast models can answer inside the tool call.
- `startVideo` submits the job to your provider and returns its id with status `queued`. Keep slow work out of the request: store the provider's job id and return.
- `getVideo` reads the job state (from your provider or your database) and maps it to `queued`, `processing`, `completed` or `failed`, with `videoUrl` when done. It must return `null` for jobs of other users.
- `getAccount` returns the balance. Charge in `startVideo` and refund on failure.

Tool names, schemas and descriptions live in `src/tools.ts`. The descriptions are what the model reads, so say there what each tool costs and how long it takes. Give anything that spends money a `scope`.

**Replace the demo account.** In `src/app.ts`, `showConsent` and `decide` use the constant `DEMO_USER_ID`. In a real application, read your session there: if nobody is signed in, send the user to your login page and back to the same URL, then call `oauth.authorize.parse(searchParams, user.id)` and `approve(token, user.id)` with the real user. The consent token is bound to that user, so a form cannot be replayed for someone else. Add your own CSRF protection if your session uses cookies.

**Use a persistent store.** `MemoryStore` loses all clients, grants and refresh tokens on restart and cannot be shared between processes. In production implement `OAuthStore` on Postgres, Redis or your own database and pass it as `store` (the [`@klakix/mcp-oauth` README](../../packages/mcp-oauth#implementing-oauthstore) has the Postgres schema and the two atomic statements). Call `oauth.cleanup()` on a schedule. The generation jobs in `DemoBackend` are also in memory; keep yours in the same database.

**Operate it.** Put it behind HTTPS and set `ISSUER` to the public origin. Set a fixed `OAUTH_CONSENT_SECRET`. Use `allowRegistration` to rate limit dynamic registration per IP, `rateLimit` on the MCP handler for tool calls, and `onToolCall` for usage records and billing.

## Test it

```sh
npm test -w examples/self-hosted
```

The end-to-end test needs no network and no build: it runs against the package sources.
