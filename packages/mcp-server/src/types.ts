import type { z } from "zod";

/**
 * Minimum shape the server needs from the authenticated caller. Your own
 * principal type may carry anything else (user id, tenant, plan, ...).
 */
export interface McpPrincipal {
  /**
   * Scopes granted to the caller. A tool that declares a `scope` is only
   * callable when that scope is present here; a principal without `scopes`
   * is treated as having none.
   */
  scopes?: ReadonlySet<string>;
}

/** Everything a tool, prompt or resource gets besides its own arguments. */
export interface McpContext<P = McpPrincipal> {
  /** The value returned by `authenticate` for this request. */
  principal: P;
  /** The incoming HTTP request (headers, URL, signal). Its body is already consumed. */
  request: Request;
}

/** A piece of tool result content. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string };

/**
 * What a tool handler returns. Build it with {@link toolOk} and
 * {@link toolError}. `meta` and `errorCode` never reach the client; they are
 * forwarded to the `onToolCall` hook for logging and billing.
 */
export interface ToolResult {
  content: ContentPart[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** Machine readable error code (set by `toolError`). Server side only. */
  errorCode?: string;
  /** Free-form record for `onToolCall` (generation ids, cost, ...). Server side only. */
  meta?: Record<string, unknown>;
}

/** Behavioral hints defined by the MCP specification. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Definition of a tool; create it with `defineTool`. */
export interface ToolDefinition<S extends z.ZodType = z.ZodType, P = any> {
  /** Unique tool name, 1 to 128 characters of `A-Z a-z 0-9 _ - .`. */
  name: string;
  /** Human readable name shown by clients. */
  title?: string;
  /** What the tool does and when to use it. This is what the model reads. */
  description: string;
  /** zod schema of the arguments. Converted to JSON Schema (draft-07) for `tools/list`. */
  inputSchema: S;
  /** Scope the principal must hold to call this tool. */
  scope?: string;
  annotations?: ToolAnnotations;
  /** Runs after the arguments passed validation. Thrown errors become tool errors. */
  handler(input: z.infer<S>, ctx: McpContext<P>): ToolResult | Promise<ToolResult>;
}

/** A tool with its schema type erased, as stored in the handler's tool list. */
export type AnyTool<P = any> = ToolDefinition<any, P>;

/** One argument of a prompt. */
export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** Definition of a prompt; create it with `definePrompt`. */
export interface PromptDefinition<P = any> {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
  /**
   * Returns the user message text. Arguments arrive as strings, trimmed to
   * 4000 characters; required ones are guaranteed to be non-empty.
   */
  render(args: Record<string, string>, ctx: McpContext<P>): string | Promise<string>;
}

/** Definition of a static or computed text resource; create it with `defineResource`. */
export interface ResourceDefinition<P = any> {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  read(ctx: McpContext<P>): string | Promise<string>;
}

/** Server identity returned by `initialize`. */
export interface ServerInfo {
  name: string;
  title?: string;
  version: string;
  websiteUrl?: string;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
}

/** Payload of the `onToolCall` hook. */
export interface ToolCallEvent<P = McpPrincipal> {
  tool: string;
  ok: boolean;
  /** Set for failed calls: `rate_limited`, `insufficient_scope`, `invalid_arguments`, a code from `toolError`, or `internal_error`. */
  errorCode?: string;
  durationMs: number;
  principal: P;
  /** The `meta` record of the tool result, if any. */
  meta?: Record<string, unknown>;
  request: Request;
}

/** Options of `createMcpHandler`. */
export interface McpHandlerOptions<P extends McpPrincipal = McpPrincipal> {
  serverInfo: ServerInfo;
  /** Usage notes for the model, returned by `initialize`. */
  instructions?: string | ((ctx: McpContext<P>) => string);
  /** Supported protocol versions, newest first. Defaults to {@link DEFAULT_PROTOCOL_VERSIONS}. */
  protocolVersions?: readonly string[];
  tools?: ReadonlyArray<AnyTool<P>>;
  prompts?: ReadonlyArray<PromptDefinition<P>>;
  resources?: ReadonlyArray<ResourceDefinition<P>>;
  /** Resolve the caller from the request (usually the bearer token). Return `null` for a 401. */
  authenticate(request: Request): Promise<P | null> | P | null;
  /**
   * Value of the `WWW-Authenticate` header on 401 responses. `error` is
   * `"invalid_token"` when the request carried credentials that were rejected.
   * Defaults to `Bearer`.
   */
  wwwAuthenticate?(request: Request, error?: "invalid_token"): string;
  /**
   * Application level gate that runs after authentication, for example a
   * suspended account or a closed beta. Return a `Response` to stop the
   * request (CORS headers are added), or `null` to continue.
   */
  authorize?(principal: P, request: Request): Promise<Response | null> | Response | null;
  /** Seconds the caller has to wait before the next call, or `null` when it may proceed. */
  rateLimit?(principal: P, toolName: string): Promise<number | null> | number | null;
  /** Called after every `tools/call`, including rejected ones. Errors thrown here are swallowed. */
  onToolCall?(event: ToolCallEvent<P>): void | Promise<void>;
  /**
   * Called when a tool handler throws. Return a result to use instead of the
   * generic `internal_error`; return nothing to keep the default. Log here.
   */
  onToolError?(error: unknown, info: { tool: string; principal: P; request: Request }): ToolResult | void | Promise<ToolResult | void>;
  /**
   * Schedule background work (`ctx.waitUntil` on Workers, `after` in Next.js).
   * When set, `onToolCall` runs in the background instead of delaying the response.
   */
  waitUntil?(promise: Promise<unknown>): void;
  /** Maximum request body in bytes. Default 10 MiB. */
  maxBodyBytes?: number;
  /**
   * CORS. `true` (default) sends permissive headers suitable for bearer-token
   * APIs; `false` sends none; an object overrides individual default headers.
   */
  cors?: boolean | Record<string, string>;
}

/** The object returned by `createMcpHandler`. */
export interface McpHandler {
  /** Handle one HTTP request: POST carries JSON-RPC, OPTIONS answers preflight, everything else is 405. */
  handle(request: Request): Promise<Response>;
}

/** Protocol versions supported by default, newest first. */
export const DEFAULT_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
