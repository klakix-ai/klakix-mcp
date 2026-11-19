import { inputJsonSchema, toolError, validationError } from "./define.js";
import {
  DEFAULT_PROTOCOL_VERSIONS,
  type AnyTool,
  type McpContext,
  type McpHandler,
  type McpHandlerOptions,
  type McpPrincipal,
  type ToolCallEvent,
  type ToolResult,
} from "./types.js";

type RpcId = string | number | null;
type RpcRequest = { jsonrpc: "2.0"; id?: RpcId; method: string; params?: Record<string, unknown> };
type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string; data?: unknown } };

const DEFAULT_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_ARGUMENT_LENGTH = 4000;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Standard JSON-RPC and MCP error codes used by the handler. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  ServerError: -32000,
  ResourceNotFound: -32002,
} as const;

const rpcError = (id: RpcId | undefined, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const rpcResult = (id: RpcId | undefined, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });

function isRpcRequest(message: unknown): message is RpcRequest {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads a request body, giving up (returns `null`) once it exceeds `limit` bytes. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Creates a stateless Streamable HTTP MCP server on top of the Web Fetch API.
 *
 * Each POST carries one JSON-RPC message or a batch and is answered with plain
 * JSON: no session id, no SSE stream, no state between requests. That makes
 * the handler safe to run on serverless platforms and behind any load
 * balancer. `GET` and `DELETE` answer 405 as the specification allows.
 *
 * Handled methods: `initialize`, `ping`, `tools/list`, `tools/call`,
 * `prompts/list`, `prompts/get`, `resources/list`, `resources/read`,
 * `resources/templates/list`, `logging/setLevel` and all notifications.
 *
 * @example
 * ```ts
 * const mcp = createMcpHandler({
 *   serverInfo: { name: "my-server", version: "1.0.0" },
 *   tools: [echo],
 *   authenticate: async (req) => verifyToken(req.headers.get("authorization")),
 * });
 * export const POST = (req: Request) => mcp.handle(req);
 * ```
 */
export function createMcpHandler<P extends McpPrincipal = McpPrincipal>(options: McpHandlerOptions<P>): McpHandler {
  const versions = options.protocolVersions?.length ? options.protocolVersions : DEFAULT_PROTOCOL_VERSIONS;
  const latest = versions[0] as string;
  const tools = options.tools ?? [];
  const prompts = options.prompts ?? [];
  const resources = options.resources ?? [];
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const toolsByName = new Map<string, AnyTool<P>>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid tool name: "${tool.name}". Use 1-128 characters of A-Z a-z 0-9 _ - .`);
    if (toolsByName.has(tool.name)) throw new Error(`Duplicate tool name: "${tool.name}"`);
    toolsByName.set(tool.name, tool);
  }
  const promptsByName = new Map(prompts.map((p) => [p.name, p]));
  if (promptsByName.size !== prompts.length) throw new Error("Duplicate prompt name");
  const resourcesByUri = new Map(resources.map((r) => [r.uri, r]));
  if (resourcesByUri.size !== resources.length) throw new Error("Duplicate resource uri");

  // Schemas are converted once; a schema that cannot be converted fails at startup, not on the first request.
  const toolDescriptors = tools.map((tool) => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: inputJsonSchema(tool.inputSchema),
    ...(tool.title || tool.annotations ? { annotations: { ...(tool.title ? { title: tool.title } : {}), ...tool.annotations } } : {}),
  }));

  const corsHeaders: Record<string, string> =
    options.cors === false ? {} : options.cors && typeof options.cors === "object" ? { ...DEFAULT_CORS, ...options.cors } : DEFAULT_CORS;

  function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-store",
        ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        ...extra,
      },
    });
  }

  function withCors(response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders)) if (!headers.has(name)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  function negotiate(requested: unknown): string {
    return typeof requested === "string" && versions.includes(requested) ? requested : latest;
  }

  async function reportToolCall(event: ToolCallEvent<P>): Promise<void> {
    const hook = options.onToolCall;
    if (!hook) return;
    const run = Promise.resolve()
      .then(() => hook(event))
      .catch(() => undefined);
    if (options.waitUntil) options.waitUntil(run);
    else await run;
  }

  async function callTool(id: RpcId | undefined, params: Record<string, unknown>, ctx: McpContext<P>): Promise<RpcResponse> {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = toolsByName.get(name);
    if (!tool) return rpcError(id, RpcErrorCode.InvalidParams, `Unknown tool: ${name}`);

    const started = Date.now();
    let result: ToolResult;
    const wait = options.rateLimit ? await options.rateLimit(ctx.principal, tool.name) : null;
    if (wait) {
      result = toolError("rate_limited", "Too many calls. Slow down and retry later.", { retry_after_seconds: wait });
    } else if (tool.scope && !ctx.principal.scopes?.has(tool.scope)) {
      result = toolError("insufficient_scope", `This connection lacks the "${tool.scope}" permission needed for this tool.`, {
        required_scope: tool.scope,
        hint: "Ask the user to reconnect with the required permission or use a credential that has it.",
      });
    } else {
      const parsed = tool.inputSchema.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        result = validationError(parsed.error);
      } else {
        try {
          result = await tool.handler(parsed.data, ctx);
        } catch (error) {
          let mapped: ToolResult | void = undefined;
          try {
            mapped = await options.onToolError?.(error, { tool: tool.name, principal: ctx.principal, request: ctx.request });
          } catch {
            // A failing error hook must not mask the original failure.
          }
          result = mapped ?? toolError("internal_error", "The tool failed unexpectedly.");
        }
      }
    }

    const { meta, errorCode, ...visible } = result;
    await reportToolCall({
      tool: tool.name,
      ok: !result.isError,
      ...(result.isError ? { errorCode: errorCode ?? "tool_error" } : {}),
      durationMs: Date.now() - started,
      principal: ctx.principal,
      ...(meta ? { meta } : {}),
      request: ctx.request,
    });
    return rpcResult(id, visible);
  }

  async function dispatch(message: RpcRequest, ctx: McpContext<P>): Promise<RpcResponse | null> {
    const { id, method } = message;
    const isNotification = id === undefined;
    const params = asRecord(message.params);

    switch (method) {
      case "initialize": {
        const instructions = typeof options.instructions === "function" ? options.instructions(ctx) : options.instructions;
        return rpcResult(id, {
          protocolVersion: negotiate(params.protocolVersion),
          capabilities: {
            ...(tools.length ? { tools: { listChanged: false } } : {}),
            ...(prompts.length ? { prompts: { listChanged: false } } : {}),
            ...(resources.length ? { resources: { listChanged: false, subscribe: false } } : {}),
          },
          serverInfo: options.serverInfo,
          ...(instructions ? { instructions } : {}),
        });
      }
      case "ping":
      case "logging/setLevel":
        return isNotification ? null : rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: toolDescriptors });
      case "tools/call":
        return callTool(id, params, ctx);
      case "prompts/list":
        return rpcResult(id, {
          prompts: prompts.map((p) => ({
            name: p.name,
            ...(p.title ? { title: p.title } : {}),
            ...(p.description ? { description: p.description } : {}),
            arguments: p.arguments ?? [],
          })),
        });
      case "prompts/get": {
        const name = String(params.name ?? "");
        const prompt = promptsByName.get(name);
        if (!prompt) return rpcError(id, RpcErrorCode.InvalidParams, `Unknown prompt: ${name}`);
        const args = Object.fromEntries(
          Object.entries(asRecord(params.arguments)).map(([key, value]) => [key, String(value ?? "").slice(0, MAX_PROMPT_ARGUMENT_LENGTH)]),
        );
        const missing = (prompt.arguments ?? []).filter((a) => a.required && !args[a.name]?.trim()).map((a) => a.name);
        if (missing.length) return rpcError(id, RpcErrorCode.InvalidParams, `Missing arguments: ${missing.join(", ")}`);
        const text = await prompt.render(args, ctx);
        return rpcResult(id, { ...(prompt.description ? { description: prompt.description } : {}), messages: [{ role: "user", content: { type: "text", text } }] });
      }
      case "resources/list":
        return rpcResult(id, {
          resources: resources.map((r) => ({
            uri: r.uri,
            name: r.name,
            ...(r.title ? { title: r.title } : {}),
            ...(r.description ? { description: r.description } : {}),
            mimeType: r.mimeType,
          })),
        });
      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });
      case "resources/read": {
        const uri = String(params.uri ?? "");
        const resource = resourcesByUri.get(uri);
        if (!resource) return rpcError(id, RpcErrorCode.ResourceNotFound, `Resource not found: ${uri}`);
        const text = await resource.read(ctx);
        return rpcResult(id, { contents: [{ uri, mimeType: resource.mimeType, text }] });
      }
      default:
        if (isNotification || method.startsWith("notifications/")) return null;
        return rpcError(id, RpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  /** Runs one message; a throwing prompt or resource becomes a JSON-RPC internal error. */
  async function safeDispatch(message: RpcRequest, ctx: McpContext<P>): Promise<RpcResponse | null> {
    try {
      return await dispatch(message, ctx);
    } catch {
      return message.id === undefined ? null : rpcError(message.id, -32603, "Internal error");
    }
  }

  async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "POST") {
      return json(rpcError(null, RpcErrorCode.ServerError, "Method not allowed. This server is stateless: send JSON-RPC with POST."), 405, { Allow: "POST, OPTIONS" });
    }

    const principal = await options.authenticate(request);
    if (!principal) {
      const error = request.headers.has("authorization") ? ("invalid_token" as const) : undefined;
      const challenge = options.wwwAuthenticate ? options.wwwAuthenticate(request, error) : error ? `Bearer error="${error}"` : "Bearer";
      return json(
        { error: "invalid_token", error_description: "Authentication required: provide a valid access token." },
        401,
        { "WWW-Authenticate": challenge },
      );
    }

    if (options.authorize) {
      const denied = await options.authorize(principal, request);
      if (denied) return withCors(denied);
    }

    const text = await readLimited(request, maxBody);
    if (text === null) return json(rpcError(null, RpcErrorCode.InvalidRequest, "Request too large"), 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(rpcError(null, RpcErrorCode.ParseError, "Parse error"), 400);
    }

    const ctx: McpContext<P> = { principal, request };
    const versionHeader = request.headers.get("mcp-protocol-version");
    const headers = { "MCP-Protocol-Version": negotiate(versionHeader) };

    if (Array.isArray(body)) {
      if (!body.length) return json(rpcError(null, RpcErrorCode.InvalidRequest, "Invalid Request"), 400);
      const responses: RpcResponse[] = [];
      for (const item of body) {
        if (!isRpcRequest(item)) {
          // Client responses to server requests carry result or error and need no reply; anything else is malformed.
          if (item && typeof item === "object" && "id" in item && !("result" in item) && !("error" in item)) {
            responses.push(rpcError(null, RpcErrorCode.InvalidRequest, "Invalid Request"));
          }
          continue;
        }
        const response = await safeDispatch(item, ctx);
        if (response) responses.push(response);
      }
      return responses.length ? json(responses, 200, headers) : json(null, 202);
    }

    if (!isRpcRequest(body)) {
      if (body && typeof body === "object" && ("result" in body || "error" in body)) return json(null, 202);
      return json(rpcError(null, RpcErrorCode.InvalidRequest, "Invalid Request"), 400);
    }
    const response = await safeDispatch(body, ctx);
    return response ? json(response, 200, headers) : json(null, 202);
  }

  return { handle };
}
