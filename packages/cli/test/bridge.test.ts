import { describe, expect, it } from "vitest";
import { AUTH_MESSAGE, createBridge } from "../src/bridge.js";

const KEY = "avy_sk_test_secret_value";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function sse(events: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

async function* lines(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield `${item}\n`;
}

async function runBridge(
  input: AsyncIterable<string | Uint8Array>,
  responder: Responder,
  extra: { apiKey?: string | undefined; timeoutMs?: number } = {},
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const logs: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as unknown,
    };
    calls.push(call);
    return responder(call, init ?? {});
  }) as typeof fetch;
  const bridge = createBridge({
    url: "https://klakix.test/api/mcp",
    apiKey: "apiKey" in extra ? extra.apiKey : KEY,
    timeoutMs: extra.timeoutMs ?? 5000,
    userAgent: "klakix-mcp/9.9.9",
    fetch: fakeFetch,
    input,
    write: (line) => out.push(line),
    log: (message) => logs.push(message),
  });
  await bridge.run();
  return { calls, out: out.map((l) => JSON.parse(l) as Record<string, unknown>), rawOut: out, logs };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const initResult = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {} } };

describe("createBridge", () => {
  it("sends the expected headers and the negotiated protocol version", async () => {
    const result = await runBridge(
      lines([JSON.stringify(init), JSON.stringify(initialized), JSON.stringify(listTools)]),
      (call) => {
        const body = call.body as { method: string };
        if (body.method === "initialize") return json(initResult);
        if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
        return new Response(null, { status: 202 });
      },
    );
    expect(result.calls).toHaveLength(3);
    const [first, second, third] = result.calls as [Call, Call, Call];
    expect(first.url).toBe("https://klakix.test/api/mcp");
    expect(first.headers["Content-Type"]).toBe("application/json");
    expect(first.headers["Accept"]).toBe("application/json, text/event-stream");
    expect(first.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(first.headers["User-Agent"]).toBe("klakix-mcp/9.9.9");
    expect(first.headers["MCP-Protocol-Version"]).toBeUndefined();
    expect(second.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
    expect(third.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
    expect(result.out).toEqual([initResult, { jsonrpc: "2.0", id: 2, result: { tools: [] } }]);
  });

  it("echoes a session id the server returns", async () => {
    const result = await runBridge(lines([JSON.stringify(init), JSON.stringify(listTools)]), (call) => {
      const body = call.body as { method: string };
      if (body.method === "initialize") return json(initResult, { headers: { "mcp-session-id": "sess-1", "content-type": "application/json" } });
      return json({ jsonrpc: "2.0", id: 2, result: {} });
    });
    expect(result.calls[0]?.headers["Mcp-Session-Id"]).toBeUndefined();
    expect(result.calls[1]?.headers["Mcp-Session-Id"]).toBe("sess-1");
  });

  it("omits Authorization when no key is set", async () => {
    const result = await runBridge(lines([JSON.stringify(listTools)]), () => json({ jsonrpc: "2.0", id: 2, result: {} }), {
      apiKey: undefined,
    });
    expect(result.calls[0]?.headers["Authorization"]).toBeUndefined();
  });

  it("makes later requests wait for the initialize response", async () => {
    let release: (() => void) | undefined;
    const started: string[] = [];
    const result = await runBridge(lines([JSON.stringify(init), JSON.stringify(listTools)]), async (call) => {
      const body = call.body as { method: string };
      started.push(body.method);
      if (body.method === "initialize") {
        await new Promise<void>((resolve) => {
          release = resolve;
          setTimeout(resolve, 30);
        });
        return json(initResult);
      }
      expect(started).toEqual(["initialize", "tools/list"]);
      return json({ jsonrpc: "2.0", id: 2, result: {} });
    });
    void release;
    expect(result.calls.map((c) => (c.body as { method: string }).method)).toEqual(["initialize", "tools/list"]);
    expect(result.calls[1]?.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
  });

  it("processes requests concurrently and lets responses arrive in any order", async () => {
    const slow = { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "slow" } };
    const fast = { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "fast" } };
    const result = await runBridge(lines([JSON.stringify(slow), JSON.stringify(fast)]), async (call) => {
      const body = call.body as { id: number };
      if (body.id === 10) await new Promise((r) => setTimeout(r, 40));
      return json({ jsonrpc: "2.0", id: body.id, result: { ok: body.id } });
    });
    expect(result.out.map((m) => m["id"])).toEqual([11, 10]);
  });

  it("writes every message of a batched JSON response on its own line", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 1, result: { a: 1 } },
      { jsonrpc: "2.0", id: 2, result: { b: 2 } },
    ];
    const result = await runBridge(
      lines([JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }])]),
      () => json(batch),
    );
    expect(result.rawOut).toHaveLength(2);
    expect(result.out).toEqual(batch);
    for (const line of result.rawOut) expect(line).not.toContain("\n");
  });

  it("writes nothing for a 202 response", async () => {
    const result = await runBridge(lines([JSON.stringify(initialized)]), () => new Response(null, { status: 202 }));
    expect(result.rawOut).toEqual([]);
  });

  it("reads JSON-RPC messages from an SSE response", async () => {
    const result = await runBridge(lines([JSON.stringify(listTools)]), () =>
      sse([
        ": keep-alive\n\n",
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
        'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":2,"result":{"tools":[]}}\r\n\r\n',
      ]),
    );
    expect(result.out).toEqual([
      { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
  });

  it("handles SSE events split across chunks and a last event without a blank line", async () => {
    const result = await runBridge(lines([JSON.stringify(listTools)]), () =>
      sse(['data: {"jsonrpc":"2.0","id"', ':2,"result":{}}\n', "\n", 'data: {"jsonrpc":"2.0","id":3,"result":{}}']),
    );
    expect(result.out.map((m) => m["id"])).toEqual([2, 3]);
  });

  it("returns a JSON-RPC auth error for a 401 on a request", async () => {
    const result = await runBridge(lines([JSON.stringify(init)]), () => new Response("unauthorized", { status: 401 }));
    expect(result.out).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32001, message: AUTH_MESSAGE } },
    ]);
    expect(AUTH_MESSAGE).toContain("https://klakix.com/app/mcp");
    expect(AUTH_MESSAGE).toContain("KLAKIX_API_KEY");
  });

  it("returns a -32603 error for other HTTP failures and network errors", async () => {
    let n = 0;
    const result = await runBridge(
      lines([
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
        JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
      ]),
      () => {
        n += 1;
        if (n === 1) return new Response("Bad gateway", { status: 502 });
        throw new TypeError("fetch failed");
      },
    );
    const byId = new Map(result.out.map((m) => [m["id"], m]));
    const e5 = byId.get(5) as { error: { code: number; message: string } };
    const e6 = byId.get(6) as { error: { code: number; message: string } };
    expect(e5.error.code).toBe(-32603);
    expect(e5.error.message).toContain("HTTP 502");
    expect(e6.error.code).toBe(-32603);
    expect(e6.error.message).toContain("fetch failed");
  });

  it("passes through a JSON-RPC error body sent with an HTTP error status", async () => {
    const body = { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad params" } };
    const result = await runBridge(lines([JSON.stringify(listTools)]), () => json(body, { status: 400 }));
    expect(result.out).toEqual([body]);
  });

  it("never answers notifications, even on errors", async () => {
    const a = await runBridge(lines([JSON.stringify(initialized)]), () => new Response("no", { status: 401 }));
    const b = await runBridge(lines([JSON.stringify(initialized)]), () => {
      throw new TypeError("fetch failed");
    });
    const c = await runBridge(lines([JSON.stringify(initialized)]), () => new Response("boom", { status: 500 }));
    expect(a.rawOut).toEqual([]);
    expect(b.rawOut).toEqual([]);
    expect(c.rawOut).toEqual([]);
  });

  it("answers an invalid JSON line with a parse error", async () => {
    const result = await runBridge(lines(["{not json", JSON.stringify(listTools)]), () => json({ jsonrpc: "2.0", id: 2, result: {} }));
    expect(result.out[0]).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: expect.any(String) } });
    expect(result.calls).toHaveLength(1);
  });

  it("handles a message split across stdin chunks and a missing final newline", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const text = JSON.stringify(listTools);
      const bytes = new TextEncoder().encode(text);
      yield bytes.slice(0, 10);
      yield bytes.slice(10);
    }
    const result = await runBridge(chunks(), () => json({ jsonrpc: "2.0", id: 2, result: {} }));
    expect(result.out).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
  });

  it("returns a timeout error when the server does not answer in time", async () => {
    const result = await runBridge(
      lines([JSON.stringify(listTools)]),
      (_call, requestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestInit.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      { timeoutMs: 30 },
    );
    const error = (result.out[0] as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("timed out");
  });

  it("never lets the API key reach stdout or the log", async () => {
    const result = await runBridge(
      lines([JSON.stringify(init), JSON.stringify(listTools)]),
      (call) => {
        const body = call.body as { method: string };
        if (body.method === "initialize") return json(initResult);
        throw new TypeError(`connect failed for Bearer ${KEY}`);
      },
    );
    const everything = [...result.rawOut, ...result.logs].join("\n");
    expect(everything).not.toContain(KEY);
    expect(result.logs.length).toBeGreaterThan(0);
    expect(everything).toContain("[redacted]");
  });
});
