/**
 * stdio to Streamable HTTP bridge for MCP.
 *
 * Reads newline-delimited JSON-RPC from an input stream, POSTs every message
 * to a remote MCP endpoint and writes each JSON-RPC message it gets back as one
 * line. fetch, input and output are injected so the bridge is testable.
 */

export type JsonRpcId = string | number | null;

export interface BridgeOptions {
  /** Remote MCP endpoint, for example https://klakix.com/api/mcp. */
  url: string;
  /** Bearer token. Never logged or written to the output. */
  apiKey?: string | undefined;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Value of the User-Agent header, for example klakix-mcp/0.1.0. */
  userAgent: string;
  /** fetch implementation. */
  fetch: typeof fetch;
  /** Chunks of stdin. The stream ending means no more messages. */
  input: AsyncIterable<string | Uint8Array>;
  /** Writes one complete line (without the trailing newline) to stdout. */
  write: (line: string) => void;
  /** Diagnostic sink (stderr). Called only when provided. */
  log?: ((message: string) => void) | undefined;
}

export interface Bridge {
  /** Resolves when input has ended and every pending request has finished. */
  run(): Promise<void>;
  /** Aborts in-flight requests and stops reading. Writes nothing more. */
  close(): void;
}

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_INTERNAL = -32603;
export const ERR_AUTH = -32001;

export const AUTH_MESSAGE =
  "Klakix API key required. Create one at https://klakix.com/app/mcp and set it in the KLAKIX_API_KEY environment variable of this MCP server entry.";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(message: unknown): message is Json & { id: string | number } {
  return (
    isObject(message) &&
    typeof message["method"] === "string" &&
    (typeof message["id"] === "string" || typeof message["id"] === "number")
  );
}

function requestIds(payload: unknown): Array<string | number> {
  const items = Array.isArray(payload) ? payload : [payload];
  const ids: Array<string | number> = [];
  for (const item of items) if (isRequest(item)) ids.push(item.id);
  return ids;
}

function hasMethod(payload: unknown, method: string): boolean {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.some((item) => isRequest(item) && item["method"] === method);
}

export function createBridge(options: BridgeOptions): Bridge {
  const { url, apiKey, timeoutMs, userAgent, input, write } = options;
  const doFetch = options.fetch;
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let protocolVersion: string | undefined;
  let sessionId: string | undefined;
  // Later requests wait until the initialize round trip has finished.
  let gate: Promise<void> = Promise.resolve();

  const redact = (text: string): string => {
    if (apiKey && apiKey.length > 0) return text.split(apiKey).join("[redacted]");
    return text;
  };
  const log = (message: string): void => {
    if (options.log) options.log(redact(message));
  };
  const emit = (message: unknown): void => {
    if (closed) return;
    write(JSON.stringify(message));
  };
  const emitError = (id: JsonRpcId, code: number, message: string): void => {
    emit({ jsonrpc: "2.0", id, error: { code, message: redact(message) } });
  };
  const failRequests = (payload: unknown, code: number, message: string): void => {
    for (const id of requestIds(payload)) emitError(id, code, message);
  };

  function emitServerPayload(payload: unknown, sawInitialize: boolean): void {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      if (!isObject(item)) continue;
      if (sawInitialize && isObject(item["result"])) {
        const version = item["result"]["protocolVersion"];
        if (typeof version === "string") protocolVersion = version;
      }
      emit(item);
    }
  }

  async function readSse(response: Response, sawInitialize: boolean): Promise<void> {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const dispatch = (): void => {
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      dataLines = [];
      if (data.trim() === "") return;
      try {
        emitServerPayload(JSON.parse(data) as unknown, sawInitialize);
      } catch {
        log("ignored an SSE event that is not valid JSON");
      }
    };
    const processLine = (line: string): void => {
      if (line === "") {
        dispatch();
        return;
      }
      if (line.startsWith(":")) return;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
    };
    const drain = (final: boolean): void => {
      let text = buffer;
      let held = "";
      if (!final && text.endsWith("\r")) {
        held = "\r";
        text = text.slice(0, -1);
      }
      text = text.replace(/\r\n?/g, "\n");
      const lines = text.split("\n");
      const rest = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      if (final && rest !== "") processLine(rest);
      buffer = final ? "" : rest + held;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
    buffer += decoder.decode();
    drain(true);
    dispatch();
  }

  async function post(payload: unknown): Promise<void> {
    const sawInitialize = hasMethod(payload, "initialize");
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": userAgent,
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    if (protocolVersion && !sawInitialize) headers["MCP-Protocol-Version"] = protocolVersion;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      log(`POST ${url} -> ${response.status}`);

      const session = response.headers.get("mcp-session-id");
      if (session) sessionId = session;

      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        failRequests(payload, ERR_AUTH, AUTH_MESSAGE);
        return;
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

      if (response.ok && contentType.includes("text/event-stream")) {
        await readSse(response, sawInitialize);
        return;
      }

      const text = await response.text();

      if (!response.ok) {
        // A JSON-RPC error body from the server is more useful than a generic one.
        if (contentType.includes("json")) {
          try {
            const parsed = JSON.parse(text) as unknown;
            const items = Array.isArray(parsed) ? parsed : [parsed];
            if (items.length > 0 && items.every((i) => isObject(i) && "jsonrpc" in i)) {
              emitServerPayload(parsed, false);
              return;
            }
          } catch {
            // fall through to the generic error
          }
        }
        const snippet = text.replace(/\s+/g, " ").trim().slice(0, 200);
        failRequests(
          payload,
          ERR_INTERNAL,
          `Klakix MCP server returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
        );
        return;
      }

      if (text.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        failRequests(payload, ERR_INTERNAL, "Klakix MCP server returned a response that is not valid JSON");
        return;
      }
      emitServerPayload(parsed, sawInitialize);
    } catch (error) {
      if (closed) return;
      if (timedOut) {
        failRequests(
          payload,
          ERR_INTERNAL,
          `Request to the Klakix MCP server timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        );
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
      log(`request failed: ${detail}${cause}`);
      failRequests(payload, ERR_INTERNAL, `Could not reach the Klakix MCP server: ${detail}${cause}`);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  function track(task: Promise<void>): void {
    const tracked: Promise<void> = task
      .catch((error: unknown) => {
        log(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        pending.delete(tracked);
      });
    pending.add(tracked);
  }

  function dispatchPayload(payload: unknown): void {
    if (hasMethod(payload, "initialize")) {
      const task = post(payload);
      gate = task.catch(() => undefined);
      track(task);
      return;
    }
    const wait = gate;
    track(wait.then(() => post(payload)));
  }

  function handleLine(raw: string): void {
    const line = raw.trim();
    if (line === "") return;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      emitError(null, ERR_PARSE, "Parse error: input line is not valid JSON");
      return;
    }
    const valid = Array.isArray(payload)
      ? payload.length > 0 && payload.every(isObject)
      : isObject(payload);
    if (!valid) {
      emitError(null, ERR_INVALID_REQUEST, "Invalid request: expected a JSON-RPC message object");
      return;
    }
    dispatchPayload(payload);
  }

  async function run(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of input) {
      if (closed) break;
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (!closed) {
      buffer += decoder.decode();
      handleLine(buffer);
    }
    while (pending.size > 0) await Promise.all([...pending]);
  }

  function close(): void {
    closed = true;
    for (const controller of controllers) controller.abort();
  }

  return { run, close };
}
