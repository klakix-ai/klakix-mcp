import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createMcpHandler,
  defineResource,
  definePrompt,
  defineTool,
  forPrincipal,
  toolError,
  toolOk,
  type McpHandlerOptions,
  type McpPrincipal,
  type ToolCallEvent,
} from "../src/index.js";

type Principal = McpPrincipal & { userId: string };

const typed = forPrincipal<Principal>();

const echo = typed.defineTool({
  name: "echo",
  title: "Echo",
  description: "Repeat a message.",
  inputSchema: z.object({ message: z.string().min(1).describe("Text to repeat"), times: z.number().int().min(1).max(5).optional() }),
  annotations: { readOnlyHint: true },
  handler: ({ message, times }, ctx) => toolOk(`${ctx.principal.userId}: ${message.repeat(times ?? 1)}`, { message }, [], { cost: 3 }),
});

const generate = typed.defineTool({
  name: "generate",
  description: "Needs the generate scope.",
  inputSchema: z.object({}),
  scope: "generate",
  handler: () => toolOk("started"),
});

const failing = defineTool({
  name: "failing",
  description: "Returns a tool error.",
  inputSchema: z.object({}),
  handler: () => toolError("out_of_credit", "Not enough credit.", { hint: "Top up." }),
});

const throwing = defineTool({
  name: "throwing",
  description: "Throws.",
  inputSchema: z.object({}),
  handler: () => {
    throw new Error("secret internals");
  },
});

const guide = definePrompt({
  name: "write_brief",
  title: "Write a brief",
  description: "Draft a brief.",
  arguments: [
    { name: "topic", description: "What to write about", required: true },
    { name: "tone", description: "Voice" },
  ],
  render: ({ topic, tone }) => `Write a brief about ${topic}${tone ? ` in a ${tone} tone` : ""}.`,
});

const manual = defineResource({
  uri: "docs://manual",
  name: "manual",
  title: "Manual",
  mimeType: "text/markdown",
  read: () => "# Manual",
});

function build(overrides: Partial<McpHandlerOptions<Principal>> = {}) {
  const events: ToolCallEvent<Principal>[] = [];
  const principal: Principal = { userId: "u1", scopes: new Set(["read"]) };
  const mcp = createMcpHandler<Principal>({
    serverInfo: { name: "test-server", title: "Test Server", version: "1.2.3", websiteUrl: "https://example.com" },
    instructions: (ctx) => `Hello ${ctx.principal.userId}`,
    tools: [echo, generate, failing, throwing],
    prompts: [guide],
    resources: [manual],
    authenticate: (request) => (request.headers.get("authorization") === "Bearer good" ? principal : null),
    onToolCall: (event) => void events.push(event),
    ...overrides,
  });
  return { mcp, events, principal };
}

function post(body: unknown, headers: Record<string, string> = { authorization: "Bearer good" }): Request {
  return new Request("https://api.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rpc(mcp: { handle(r: Request): Promise<Response> }, body: unknown, headers?: Record<string, string>) {
  const response = await mcp.handle(post(body, headers));
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

const call = (name: string, args: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("transport", () => {
  it("answers 401 with a WWW-Authenticate challenge when unauthenticated", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "ping" }, {});
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
    expect(r.body.error).toBe("invalid_token");
  });

  it("uses the custom challenge and flags rejected credentials", async () => {
    const wwwAuthenticate = vi.fn(
      (_req: Request, error?: string) => `Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"${error ? `, error="${error}"` : ""}`,
    );
    const { mcp } = build({ wwwAuthenticate });
    const anonymous = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "ping" }, {});
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"');
    const rejected = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer bad" });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("answers preflight without authentication", async () => {
    const { mcp } = build();
    const response = await mcp.handle(new Request("https://api.example.com/mcp", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("answers 405 for GET and DELETE", async () => {
    const { mcp } = build();
    for (const method of ["GET", "DELETE"]) {
      const response = await mcp.handle(new Request("https://api.example.com/mcp", { method, headers: { authorization: "Bearer good" } }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    }
  });

  it("can disable or override CORS", async () => {
    const off = build({ cors: false }).mcp;
    const a = await off.handle(new Request("https://api.example.com/mcp", { method: "OPTIONS" }));
    expect(a.headers.get("access-control-allow-origin")).toBeNull();
    const custom = build({ cors: { "Access-Control-Allow-Origin": "https://app.example.com" } }).mcp;
    const b = await custom.handle(new Request("https://api.example.com/mcp", { method: "OPTIONS" }));
    expect(b.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(b.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("returns a gate response from authorize with CORS headers added", async () => {
    const { mcp } = build({ authorize: () => new Response("suspended", { status: 403 }) });
    const response = await mcp.handle(post({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("suspended");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects malformed JSON with -32700 and oversized bodies with 413", async () => {
    const { mcp } = build({ maxBodyBytes: 100 });
    const bad = await rpc(mcp, "{nope");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(-32700);
    const big = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(500) } });
    expect(big.status).toBe(413);
  });

  it("rejects invalid and empty requests with 400", async () => {
    const { mcp } = build();
    expect((await rpc(mcp, { hello: "world" })).status).toBe(400);
    expect((await rpc(mcp, [])).status).toBe(400);
  });

  it("answers notifications and client responses with 202 and no body", async () => {
    const { mcp } = build();
    const note = await rpc(mcp, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(note.body).toBeNull();
    const reply = await rpc(mcp, { jsonrpc: "2.0", id: 5, result: {} });
    expect(reply.status).toBe(202);
  });

  it("answers a batch per request id and drops notifications", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "prompts/list" },
      { jsonrpc: "2.0", id: 3, method: "nope/nope" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(3);
    expect(r.body.map((x: { id: number }) => x.id)).toEqual([1, 2, 3]);
    expect(r.body[2].error.code).toBe(-32601);
  });

  it("answers 202 for a batch of only notifications", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(r.status).toBe(202);
  });

  it("returns -32601 with the request id for unknown methods", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 7, method: "does/not/exist" });
    expect(r.body.error.code).toBe(-32601);
    expect(r.body.id).toBe(7);
  });
});

describe("initialize", () => {
  it("negotiates the protocol version and reports identity, capabilities and instructions", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(r.body.result.protocolVersion).toBe("2025-06-18");
    expect(r.body.result.serverInfo).toEqual({ name: "test-server", title: "Test Server", version: "1.2.3", websiteUrl: "https://example.com" });
    expect(r.body.result.capabilities).toEqual({
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
    });
    expect(r.body.result.instructions).toBe("Hello u1");
  });

  it("falls back to the newest version for an unknown request", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(r.body.result.protocolVersion).toBe("2025-11-25");
  });

  it("honors a custom version list and omits capabilities that have no entries", async () => {
    const { mcp } = build({ protocolVersions: ["2025-03-26"], prompts: [], resources: [] });
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    expect(r.body.result.protocolVersion).toBe("2025-03-26");
    expect(r.body.result.capabilities).toEqual({ tools: { listChanged: false } });
  });
});

describe("tools/list", () => {
  it("lists tools with draft-07 object schemas and annotations", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = r.body.result.tools as Array<Record<string, any>>;
    expect(tools.map((t) => t.name)).toEqual(["echo", "generate", "failing", "throwing"]);
    const echoTool = tools[0]!;
    expect(echoTool.title).toBe("Echo");
    expect(echoTool.inputSchema.$schema).toBeUndefined();
    expect(echoTool.inputSchema.type).toBe("object");
    expect(echoTool.inputSchema.required).toEqual(["message"]);
    expect(echoTool.inputSchema.properties.message).toMatchObject({ type: "string", description: "Text to repeat" });
    expect(echoTool.inputSchema.properties.times).toMatchObject({ type: "integer", minimum: 1, maximum: 5 });
    expect(echoTool.annotations).toEqual({ title: "Echo", readOnlyHint: true });
    expect(tools[2]!.inputSchema).toMatchObject({ type: "object", properties: {} });
  });

  it("rejects duplicate and invalid tool names at creation", () => {
    expect(() => build({ tools: [echo, echo] })).toThrow(/Duplicate tool name/);
    expect(() => build({ tools: [defineTool({ name: "bad name", description: "x", inputSchema: z.object({}), handler: () => toolOk("x") })] })).toThrow(/Invalid tool name/);
  });
});

describe("tools/call", () => {
  it("runs the handler with a typed principal and returns text plus structured content", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, call("echo", { message: "hi", times: 2 }));
    expect(r.body.result.isError).toBeUndefined();
    expect(r.body.result.content[0].text).toContain("u1: hihi");
    expect(r.body.result.structuredContent).toEqual({ message: "hi" });
  });

  it("never sends meta or errorCode to the client but reports meta to onToolCall", async () => {
    const { mcp, events } = build();
    const r = await rpc(mcp, call("echo", { message: "hi" }));
    expect(r.body.result.meta).toBeUndefined();
    expect(r.body.result.errorCode).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "echo", ok: true, meta: { cost: 3 }, principal: { userId: "u1" } });
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]!.errorCode).toBeUndefined();
  });

  it("turns invalid arguments into a readable tool error without calling the handler", async () => {
    const handler = vi.fn(() => toolOk("ran"));
    const { mcp, events } = build({ tools: [defineTool({ name: "strict", description: "x", inputSchema: z.object({ n: z.number() }), handler })] });
    const r = await rpc(mcp, call("strict", { n: "five" }));
    expect(handler).not.toHaveBeenCalled();
    expect(r.body.result.isError).toBe(true);
    const error = r.body.result.structuredContent.error;
    expect(error.code).toBe("invalid_arguments");
    expect(error.issues[0].path).toBe("n");
    expect(r.body.result.content[0].text).toContain("n:");
    expect(events[0]).toMatchObject({ ok: false, errorCode: "invalid_arguments" });
  });

  it("treats missing arguments as an empty object", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.structuredContent.error.issues[0].path).toBe("message");
  });

  it("returns -32602 for an unknown tool", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, call("nope"));
    expect(r.body.error.code).toBe(-32602);
  });

  it("enforces tool scopes", async () => {
    const { mcp, events, principal } = build();
    const denied = await rpc(mcp, call("generate"));
    expect(denied.body.result.isError).toBe(true);
    expect(denied.body.result.structuredContent.error).toMatchObject({ code: "insufficient_scope", required_scope: "generate" });
    expect(events[0]).toMatchObject({ ok: false, errorCode: "insufficient_scope" });
    principal.scopes = new Set(["read", "generate"]);
    const allowed = await rpc(mcp, call("generate"));
    expect(allowed.body.result.isError).toBeUndefined();
  });

  it("treats a principal without scopes as holding none", async () => {
    const { mcp } = build({ authenticate: () => ({ userId: "u2" }) });
    const r = await rpc(mcp, call("generate"), {});
    expect(r.body.result.structuredContent.error.code).toBe("insufficient_scope");
  });

  it("applies the rate limit before running the tool", async () => {
    const rateLimit = vi.fn(async (_p: Principal, tool: string) => (tool === "echo" ? 30 : null));
    const { mcp, events } = build({ rateLimit });
    const limited = await rpc(mcp, call("echo", { message: "hi" }));
    expect(limited.body.result.isError).toBe(true);
    expect(limited.body.result.structuredContent.error).toMatchObject({ code: "rate_limited", retry_after_seconds: 30 });
    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "echo");
    expect(events[0]).toMatchObject({ tool: "echo", ok: false, errorCode: "rate_limited" });
    const free = await rpc(mcp, call("failing"));
    expect(free.body.result.structuredContent.error.code).toBe("out_of_credit");
  });

  it("reports the error code of tool errors", async () => {
    const { mcp, events } = build();
    const r = await rpc(mcp, call("failing"));
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("Not enough credit.");
    expect(r.body.result.structuredContent.error).toEqual({ code: "out_of_credit", message: "Not enough credit.", hint: "Top up." });
    expect(events[0]).toMatchObject({ ok: false, errorCode: "out_of_credit" });
  });

  it("hides thrown error details and lets onToolError map them", async () => {
    const plain = build();
    const r = await rpc(plain.mcp, call("throwing"));
    expect(r.body.result.isError).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("secret internals");
    expect(r.body.result.structuredContent.error.code).toBe("internal_error");

    const seen: unknown[] = [];
    const mapped = build({
      onToolError: (error) => {
        seen.push(error);
        return toolError("custom", "Mapped.");
      },
    });
    const m = await rpc(mapped.mcp, call("throwing"));
    expect(m.body.result.structuredContent.error.code).toBe("custom");
    expect(seen).toHaveLength(1);
  });

  it("swallows errors from onToolCall and can defer it with waitUntil", async () => {
    const failingHook = build({ onToolCall: () => Promise.reject(new Error("db down")) });
    const ok = await rpc(failingHook.mcp, call("failing"));
    expect(ok.status).toBe(200);

    const pending: Promise<unknown>[] = [];
    const onToolCall = vi.fn();
    const deferred = build({ onToolCall, waitUntil: (p) => void pending.push(p) });
    await rpc(deferred.mcp, call("failing"));
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(onToolCall).toHaveBeenCalledTimes(1);
  });
});

describe("prompts", () => {
  it("lists prompts with their arguments", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(r.body.result.prompts).toEqual([
      {
        name: "write_brief",
        title: "Write a brief",
        description: "Draft a brief.",
        arguments: [
          { name: "topic", description: "What to write about", required: true },
          { name: "tone", description: "Voice" },
        ],
      },
    ]);
  });

  it("renders a prompt as a user message", async () => {
    const { mcp } = build();
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "write_brief", arguments: { topic: "cats", tone: "dry" } } });
    expect(r.body.result.messages).toEqual([{ role: "user", content: { type: "text", text: "Write a brief about cats in a dry tone." } }]);
  });

  it("rejects missing required arguments and unknown prompts with -32602", async () => {
    const { mcp } = build();
    const missing = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "write_brief", arguments: { topic: "  " } } });
    expect(missing.body.error.code).toBe(-32602);
    expect(missing.body.error.message).toContain("topic");
    const unknown = await rpc(mcp, { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "nope" } });
    expect(unknown.body.error.code).toBe(-32602);
  });

  it("trims long argument values", async () => {
    const render = vi.fn((_args: Record<string, string>) => "ok");
    const { mcp } = build({ prompts: [definePrompt({ name: "p", arguments: [{ name: "a" }], render })] });
    await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "p", arguments: { a: "x".repeat(9000) } } });
    expect(render.mock.calls[0]![0].a).toHaveLength(4000);
  });
});

describe("resources", () => {
  it("lists, reads and rejects unknown resources", async () => {
    const { mcp } = build();
    const list = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect(list.body.result.resources).toEqual([{ uri: "docs://manual", name: "manual", title: "Manual", mimeType: "text/markdown" }]);
    const read = await rpc(mcp, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "docs://manual" } });
    expect(read.body.result.contents).toEqual([{ uri: "docs://manual", mimeType: "text/markdown", text: "# Manual" }]);
    const missing = await rpc(mcp, { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "docs://nope" } });
    expect(missing.body.error.code).toBe(-32002);
    const templates = await rpc(mcp, { jsonrpc: "2.0", id: 4, method: "resources/templates/list" });
    expect(templates.body.result.resourceTemplates).toEqual([]);
  });

  it("turns a throwing resource into a JSON-RPC internal error", async () => {
    const boom = defineResource({
      uri: "x://boom",
      name: "boom",
      mimeType: "text/plain",
      read: () => {
        throw new Error("nope");
      },
    });
    const { mcp } = build({ resources: [boom] });
    const r = await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "x://boom" } });
    expect(r.body.error.code).toBe(-32603);
  });
});

describe("misc methods", () => {
  it("answers ping and logging/setLevel", async () => {
    const { mcp } = build();
    expect((await rpc(mcp, { jsonrpc: "2.0", id: 1, method: "ping" })).body.result).toEqual({});
    expect((await rpc(mcp, { jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "info" } })).body.result).toEqual({});
  });
});
