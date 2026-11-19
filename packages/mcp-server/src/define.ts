import { z } from "zod";
import type {
  ContentPart,
  PromptDefinition,
  ResourceDefinition,
  ToolDefinition,
  ToolResult,
} from "./types.js";

/**
 * Declares a tool. Identity function that infers the handler input type from
 * the zod schema.
 *
 * ```ts
 * const echo = defineTool({
 *   name: "echo",
 *   description: "Repeat a message.",
 *   inputSchema: z.object({ message: z.string() }),
 *   handler: ({ message }) => toolOk(message),
 * });
 * ```
 *
 * The principal type defaults to `any`; use {@link forPrincipal} to bind your
 * own type once instead of passing generics to every call.
 */
export function defineTool<S extends z.ZodType, P = any>(tool: ToolDefinition<S, P>): ToolDefinition<S, P> {
  return tool;
}

/** Declares a prompt (a reusable message template the user can pick in the client). */
export function definePrompt<P = any>(prompt: PromptDefinition<P>): PromptDefinition<P> {
  return prompt;
}

/** Declares a text resource the client can read. */
export function defineResource<P = any>(resource: ResourceDefinition<P>): ResourceDefinition<P> {
  return resource;
}

/**
 * Returns `defineTool`, `definePrompt` and `defineResource` with the principal
 * type fixed, so handlers get a typed `ctx.principal`.
 *
 * ```ts
 * const { defineTool } = forPrincipal<{ userId: string; scopes: Set<string> }>();
 * ```
 */
export function forPrincipal<P>(): {
  defineTool: <S extends z.ZodType>(tool: ToolDefinition<S, P>) => ToolDefinition<S, P>;
  definePrompt: (prompt: PromptDefinition<P>) => PromptDefinition<P>;
  defineResource: (resource: ResourceDefinition<P>) => ResourceDefinition<P>;
} {
  return { defineTool, definePrompt, defineResource };
}

/**
 * Successful tool result. The summary and the JSON of `data` are sent as text
 * (older clients ignore `structuredContent`); `data` is also sent as
 * `structuredContent`.
 *
 * @param summary Short sentence for the model.
 * @param data Structured payload.
 * @param extraContent Additional content parts, for example a `resource_link`.
 * @param meta Server side record forwarded to `onToolCall`; never sent to the client.
 */
export function toolOk(
  summary: string,
  data?: Record<string, unknown>,
  extraContent: ContentPart[] = [],
  meta?: Record<string, unknown>,
): ToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 1)}`;
  return {
    content: [{ type: "text", text }, ...extraContent],
    ...(data === undefined ? {} : { structuredContent: data }),
    ...(meta ? { meta } : {}),
  };
}

/**
 * Failed tool result the model can act on (`isError: true`, not a JSON-RPC
 * error). `code` is machine readable; `extra` fields (for example `hint`,
 * `field`) are merged into the error object.
 */
export function toolError(code: string, message: string, extra: Record<string, unknown> = {}, meta?: Record<string, unknown>): ToolResult {
  const data = { error: { code, message, ...extra } };
  return {
    content: [{ type: "text", text: `${message}\n\n${JSON.stringify(data, null, 1)}` }],
    structuredContent: data,
    isError: true,
    errorCode: code,
    ...(meta ? { meta } : {}),
  };
}

/** Turns a zod validation error into a readable tool error with per-field messages. */
export function validationError(error: z.ZodError): ToolResult {
  const issues = error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
  return toolError("invalid_arguments", `The tool arguments are not valid. ${summary}`, {
    issues,
    hint: "Fix the listed fields and call the tool again.",
  });
}

/**
 * JSON Schema (draft-07) of a tool's input, as sent in `tools/list`. Always an
 * object schema with a `properties` map.
 */
export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object") json.type = "object";
  if (!json.properties) json.properties = {};
  return json;
}
