# Installing Klakix MCP in Cline

Klakix is a remote MCP server (Streamable HTTP). Nothing needs to be cloned or built.

1. Ask the user to create a Klakix account at https://klakix.com and an API key at https://klakix.com/app/mcp (the key starts with `avy_sk_` and is shown once). Do not invent or guess a key.
2. Add this entry to `cline_mcp_settings.json`, replacing the key with the user's own:

```json
{
  "mcpServers": {
    "klakix": {
      "type": "streamableHttp",
      "url": "https://klakix.com/api/mcp",
      "headers": { "Authorization": "Bearer avy_sk_..." }
    }
  }
}
```

3. Verify by calling the `get_account` tool (free). New accounts can make voiceovers right away; video and image tools unlock after the first credit purchase.
4. Call `estimate_cost` before any generation; every generation spends credits.

Alternative for stdio-only setups: `npx -y klakix-mcp` with the environment variable `KLAKIX_API_KEY` set.

Docs: https://klakix.com/mcp and the [README](README.md).
