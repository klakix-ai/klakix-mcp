# Klakix MCP: AI video, image and audio generation for Claude Desktop

`klakix-mcp` is a small command-line bridge that connects stdio MCP clients to the remote [Klakix](https://klakix.com) MCP server. Use it to give Claude Desktop, older MCP clients, and directories that only launch stdio servers access to AI video generation (Seedance, Kling, Veo), image generation (Nano Banana, GPT Image), voiceovers, music and sound effects.

It has no dependencies, needs Node.js 20 or newer, and runs with:

```
npx -y klakix-mcp
```

The remote server lives at `https://klakix.com/api/mcp` (Streamable HTTP, stateless, JSON responses). This package reads JSON-RPC messages from stdin, posts each one to that URL, and writes the replies to stdout. It sends your API key as a Bearer token and does nothing else with it.

## Get an API key

1. Sign in at [klakix.com](https://klakix.com).
2. Open [klakix.com/app/mcp](https://klakix.com/app/mcp) and create an API key. It starts with `avy_sk_`.
3. Put it in the `KLAKIX_API_KEY` environment variable of your MCP client entry, as shown below.

Generations spend credits from your Klakix account at the same prices as the website. The server shows the cost before it generates (`estimate_cost`).

## Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and add the server:

```json
{
  "mcpServers": {
    "klakix": {
      "command": "npx",
      "args": ["-y", "klakix-mcp"],
      "env": {
        "KLAKIX_API_KEY": "avy_sk_..."
      }
    }
  }
}
```

Restart Claude Desktop. Then ask for something like "make a 5-second product video from this photo" or "generate three thumbnail images".

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "klakix": {
      "command": "npx",
      "args": ["-y", "klakix-mcp"],
      "env": { "KLAKIX_API_KEY": "avy_sk_..." }
    }
  }
}
```

## VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "klakix": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "klakix-mcp"],
      "env": { "KLAKIX_API_KEY": "avy_sk_..." }
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "klakix": {
      "command": "npx",
      "args": ["-y", "klakix-mcp"],
      "env": { "KLAKIX_API_KEY": "avy_sk_..." }
    }
  }
}
```

## Prefer the remote connection when your client supports it

If your client can connect to a remote MCP server, use the URL directly instead of this bridge:

```
https://klakix.com/api/mcp
```

Those clients (Claude on the web and desktop connectors, ChatGPT, Claude Code, Cursor, VS Code, Codex, Gemini CLI) sign in with OAuth 2.1, so there is no API key to copy and nothing to run locally. This package is for clients that can only start a local command.

## Docker

Build from the repository root:

```
docker build -t klakix-mcp .
```

Run it as a stdio server (keep `-i`):

```
docker run -i --rm -e KLAKIX_API_KEY=avy_sk_... klakix-mcp
```

## Options

Flags take precedence over environment variables.

| Option | Environment variable | Default | Description |
|---|---|---|---|
| `--api-key <key>` | `KLAKIX_API_KEY` | none | API key sent as `Authorization: Bearer`. Prefer the environment variable, because command-line arguments are visible in process lists. |
| `--url <url>` | `KLAKIX_MCP_URL` | `https://klakix.com/api/mcp` | Remote MCP endpoint. Must be `http://` or `https://`. |
| `--timeout <seconds>` | none | `600` | Time to wait for each request. Video generation can run for minutes, so the default is ten minutes. |
| `--verbose` | none | off | Write diagnostics to stderr (status codes and errors, never the key or message bodies). |
| `--help`, `-h` | none | none | Print usage. |
| `--version`, `-v` | none | none | Print the version. |

## How it behaves

- Each line on stdin is one JSON-RPC message. Each message becomes one `POST` with `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
- After the `initialize` response, later requests carry `MCP-Protocol-Version` set to the version the server chose. If the server returns an `Mcp-Session-Id`, it is sent back on later requests.
- JSON replies (a single message or a batch) are written to stdout one message per line. `text/event-stream` replies are read as server-sent events and each `data:` payload is written as it arrives. A `202` reply writes nothing.
- Requests run concurrently, so replies can arrive in a different order than the requests. Responses are matched by `id`. Requests sent before `initialize` completes wait for it.
- Notifications never get a reply, including on errors.
- stdout carries JSON-RPC only. All diagnostics go to stderr.
- When stdin closes, the bridge waits for pending requests and then exits. `SIGINT` and `SIGTERM` stop it immediately.

## Troubleshooting

**"Klakix API key required" (error code -32001).** The server answered 401. Check that `KLAKIX_API_KEY` is set in the `env` block of the client entry, that the key was copied in full, and that it was not revoked at [klakix.com/app/mcp](https://klakix.com/app/mcp). Restart the client after changing its config.

**"Could not reach the Klakix MCP server" (error code -32603).** A network failure. Check your connection, proxy and firewall settings. Run with `--verbose` and read the client's MCP log for the underlying reason.

**"timed out after 600 seconds".** The request took longer than the timeout. Raise it with `--timeout 1800`, or ask the assistant to check the job status instead of waiting.

**The client says the server failed to start.** Run `npx -y klakix-mcp --version` in a terminal. It needs Node.js 20 or newer on the `PATH` the client uses. On Windows, if the client cannot find `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "klakix-mcp"]`.

**Checking the connection by hand.** This sends one `initialize` request and prints the reply:

```
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | npx -y klakix-mcp --verbose
```

## Related

- Klakix MCP product page: [klakix.com/mcp](https://klakix.com/mcp)
- Remote server and tool list: [repository README](../../README.md)
- Source and issues: [github.com/klakix-ai/klakix-mcp](https://github.com/klakix-ai/klakix-mcp)

## License

MIT
