<!-- mcp-name: com.klakix/mcp -->

# Klakix MCP bridge for Python

`klakix-mcp` is a small command-line bridge that connects stdio MCP clients to the remote [Klakix](https://klakix.com) MCP server. Use it to give Claude Desktop and other MCP clients that only launch local commands access to AI video generation (Seedance, Kling, Veo), image generation (Nano Banana, GPT Image), voiceovers, music and sound effects.

It is the same bridge as the [npm package](https://www.npmjs.com/package/klakix-mcp), written in pure Python. It has no dependencies, needs Python 3.9 or newer, and runs with:

```
uvx klakix-mcp
```

or, with pipx:

```
pipx run klakix-mcp
```

The remote server lives at `https://klakix.com/api/mcp` (Streamable HTTP). This package reads JSON-RPC messages from stdin, posts each one to that URL, and writes the replies to stdout. It sends your API key as a Bearer token and does nothing else with it.

## Get an API key

1. Sign in at [klakix.com](https://klakix.com).
2. Open [klakix.com/app/mcp](https://klakix.com/app/mcp) and create an API key. It starts with `avy_sk_`.
3. Put it in the `KLAKIX_API_KEY` environment variable of your MCP client entry, as shown below.

Generations spend credits from your Klakix account at the same prices as the website.

## Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and add the server:

```json
{
  "mcpServers": {
    "klakix": {
      "command": "uvx",
      "args": ["klakix-mcp"],
      "env": {
        "KLAKIX_API_KEY": "avy_sk_..."
      }
    }
  }
}
```

Restart the app, then ask for something like "make a 5-second product video from this photo".

## Remote connection without this bridge

If your client can connect to a remote MCP server, add the URL directly and sign in with OAuth instead:

```
https://klakix.com/api/mcp
```

This package is for clients that can only start a local command.

## Options

Flags take precedence over environment variables.

| Option | Environment variable | Default | Description |
|---|---|---|---|
| `--api-key <key>` | `KLAKIX_API_KEY` | none | API key sent as `Authorization: Bearer`. Prefer the environment variable, because command-line arguments are visible in process lists. |
| `--url <url>` | `KLAKIX_MCP_URL` | `https://klakix.com/api/mcp` | Remote MCP endpoint. Must be `http://` or `https://`. |
| `--timeout <seconds>` | none | `600` | Time to wait for each request. Video generation can run for minutes. |
| `--verbose` | none | off | Write diagnostics to stderr (status codes and errors, never the key or message bodies). |
| `--help`, `-h` | none | none | Print usage. |
| `--version`, `-v` | none | none | Print the version. |

## How it behaves

- Each line on stdin is one JSON-RPC message. Each message becomes one `POST` with `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
- Requests run concurrently, but nothing is sent until the `initialize` response has arrived. After it, requests carry `MCP-Protocol-Version` set to the version the server chose, and `Mcp-Session-Id` if the server returned one.
- JSON replies (one message or a batch) are written to stdout one message per line. `text/event-stream` replies are read as server-sent events. A `202` reply writes nothing.
- A `401` reply becomes a JSON-RPC error with code `-32001` that explains how to set the API key. Other failures become `-32603`. Notifications never get a reply, including on errors.
- stdout carries JSON-RPC only. Diagnostics go to stderr.
- When stdin closes, the bridge waits for pending requests and then exits.

## Checking the connection by hand

```
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | uvx klakix-mcp --verbose
```

## Related

- Klakix MCP product page: [klakix.com/mcp](https://klakix.com/mcp)
- Source and issues: [github.com/klakix-ai/klakix-mcp](https://github.com/klakix-ai/klakix-mcp)

## License

MIT
