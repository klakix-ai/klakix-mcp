# Klakix MCP server: AI video, image and audio generation for Claude, ChatGPT and Cursor

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-black)](https://modelcontextprotocol.io)
[![Auth](https://img.shields.io/badge/auth-OAuth%202.1%20%2B%20PKCE-blue)](#authentication)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![CI](https://github.com/klakix-ai/klakix-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/klakix-ai/klakix-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/klakix-mcp?label=klakix-mcp)](https://www.npmjs.com/package/klakix-mcp)
[![npm downloads](https://img.shields.io/npm/dm/klakix-mcp)](https://www.npmjs.com/package/klakix-mcp)
[![klakix-mcp MCP server](https://glama.ai/mcp/servers/klakix-ai/klakix-mcp/badges/score.svg)](https://glama.ai/mcp/servers/klakix-ai/klakix-mcp)
[![Klakix MCP connector](https://glama.ai/mcp/connectors/com.klakix/mcp/badges/score.svg)](https://glama.ai/mcp/connectors/com.klakix/mcp)

**What is it?** The Klakix MCP server lets an AI assistant make videos, images, voiceovers, music and sound effects for you: Seedance, Kling, Veo, Wan, Nano Banana and more behind one connector.

**Who is it for?** Anyone who uses Claude, ChatGPT or a coding assistant and wants generated media without leaving the chat: marketers, creators, designers and developers who prototype with AI video. No subscription; you pay credits only for what you generate.

**How do I install it?** Add one URL to Claude, ChatGPT, Claude Code, Cursor, VS Code, Cline, Devin Desktop (Windsurf), Codex or Gemini CLI, sign in with your [Klakix](https://klakix.com) account, and ask in plain language: "make a 5-second product video from this photo", "generate three thumbnail images", "read this script in a calm voice". Per-client steps are in [Setup by client](#setup-by-client).

```
https://klakix.com/api/mcp
```

- **Remote server, nothing to install.** Streamable HTTP transport, JSON responses, stateless.
- **Sign in with OAuth 2.1** (PKCE S256, dynamic client registration, client ID metadata documents) or use an API key.
- **19 tools and 7 ready-made workflows** (MCP prompts) covering video, image, audio, talking videos, effects, upscaling and templates.
- **Current models:** Seedance 2.5 and 2.0, Kling 4.0 and 3.0, Google Veo 3.1 Lite, Gemini Omni Flash, Wan 3.0, MiniMax H3 Max (Hailuo), Nano Banana 2, GPT Image 2.5, Muse Image, HeyGen Avatar IV, OmniHuman 1.5, Topaz Video AI, and Klakix voice, music and sound effect models.
- **Same prices as the website.** Every generation spends credits from your account at web prices; no subscription is required. The cost is shown before you generate (`estimate_cost`).

Product page: [klakix.com/mcp](https://klakix.com/mcp)

## What's in this repository

This is the open-source home of the Klakix MCP server. Besides the setup guide for the hosted server, it contains the building blocks we run in production, extracted as standalone MIT-licensed packages you can use for your own MCP server.

| Package | What it is |
|---|---|
| [`klakix-mcp`](packages/cli) | Stdio bridge for Claude Desktop and any stdio MCP client: `npx -y klakix-mcp`. Zero dependencies. |
| [`klakix-mcp`](packages/python) (PyPI) | Same stdio bridge in pure Python: `uvx klakix-mcp`. Zero dependencies. |
| [`@klakix/mcp-server`](packages/mcp-server) | Stateless Streamable HTTP MCP server for the Web Fetch API: tools with zod schemas, prompts, resources, scope checks, rate-limit and logging hooks, and an SSRF-safe media fetcher. Runs on Node, Next.js, Hono, Bun, Deno and Cloudflare Workers. |
| [`@klakix/mcp-oauth`](packages/mcp-oauth) | OAuth 2.1 authorization server for remote MCP servers: PKCE S256, dynamic client registration (RFC 7591), client ID metadata documents, RFC 8414 and RFC 9728 metadata, refresh token rotation with reuse detection, revocation. Storage-agnostic, zero dependencies. |
| [`examples/self-hosted`](examples/self-hosted) | A complete MCP server with OAuth sign-in and demo image and video tools that you can run locally in one command and connect to Claude Code or MCP Inspector. |


## Contents

- [Quick start](#quick-start)
- [What's in this repository](#whats-in-this-repository)
- [Setup by client](#setup-by-client)
- [Tools](#tools)
- [Workflows (prompts)](#workflows-prompts)
- [Authentication](#authentication)
- [Pricing and limits](#pricing-and-limits)
- [Safety](#safety)
- [Build your own MCP server](#build-your-own-mcp-server)
- [FAQ](#faq)

## Quick start

1. Create a free account at [klakix.com](https://klakix.com).
2. Add `https://klakix.com/api/mcp` to your MCP client (commands below).
3. Sign in when the browser opens and approve access.
4. Ask: "How many credits do I have?" then "Make a 5-second video of a paper boat on a rainy street."

New accounts can make voiceovers right away; video and image tools unlock after the first credit purchase.

## Setup by client

Ready-to-copy files are in [`configs/`](configs).

### Claude (claude.ai, desktop and mobile)

1. Open **Customize > Connectors**.
2. Click **+ Add**, then **Add custom connector**.
3. Name it `Klakix`, paste `https://klakix.com/api/mcp` as the URL and click **Continue**.
4. Keep the detected authentication settings, click **Continue** and **Add**, then sign in and approve.
5. In a new chat, click **+**, open **Connectors**, turn Klakix on and ask for a video.

The Free plan allows one custom connector. On Team and Enterprise an Owner adds it. Once added, it works on every device.

### Claude Desktop with a config file (stdio)

If you prefer a config file to the Connectors screen, or your client only runs local stdio servers, use the [`klakix-mcp`](packages/cli) bridge with an API key from [klakix.com/app/mcp](https://klakix.com/app/mcp). In `claude_desktop_config.json`:

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

### ChatGPT

1. On chatgpt.com, open **Plugins** (chatgpt.com/plugins).
2. Click **+**, then **Add custom MCP server**.
3. Paste `https://klakix.com/api/mcp` as the server URL and choose **OAuth**.
4. Confirm the warning, click **Create as a plugin**, install it, sign in and approve.
5. In a chat, type **@**, pick Klakix and ask for a video.

Fully supported on Business, Enterprise and Edu; a workspace admin may need to allow it.

### Claude Code

```bash
claude mcp add --transport http --scope user klakix https://klakix.com/api/mcp
```

Then type `/mcp` in Claude Code and sign in through the browser. With an API key instead:

```bash
claude mcp add --transport http --scope user klakix https://klakix.com/api/mcp \
  --header "Authorization: Bearer avy_sk_..."
```

### Cursor

Use the **Add to Cursor** button on [klakix.com/mcp](https://klakix.com/mcp), or put this in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "klakix": {
      "url": "https://klakix.com/api/mcp"
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "klakix": {
      "type": "http",
      "url": "https://klakix.com/api/mcp"
    }
  }
}
```

Sign in when the server starts, then open Copilot Chat in agent mode.

### Cline

In Cline, open **MCP Servers > Remote Servers** (or edit `cline_mcp_settings.json`) and add:

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

Create the API key on [klakix.com/app/mcp](https://klakix.com/app/mcp). Cline-specific install notes for agents are in [`llms-install.md`](llms-install.md).

### Devin Desktop (Windsurf)

`~/.config/devin/mcp_config.json`:

```json
{
  "mcpServers": {
    "klakix": {
      "url": "https://klakix.com/api/mcp"
    }
  }
}
```

If the server shows **Needs authentication**, click **Authenticate**.

### Codex (OpenAI)

```bash
codex mcp add klakix --url https://klakix.com/api/mcp
codex mcp login klakix
```

### Gemini CLI

```bash
gemini mcp add --transport http klakix https://klakix.com/api/mcp
```

Then run `/mcp auth` in Gemini CLI.

### n8n, Make, scripts and other clients (API key)

Create a key on [klakix.com/app/mcp](https://klakix.com/app/mcp) (shown once), then:

```json
{
  "mcpServers": {
    "klakix": {
      "type": "http",
      "url": "https://klakix.com/api/mcp",
      "headers": { "Authorization": "Bearer avy_sk_..." }
    }
  }
}
```

## Tools

### Create (spends credits)

| Tool | What it does |
|---|---|
| `generate_video` | Video from text, a photo or references (Veo, Kling, Seedance, Wan, MiniMax, Gemini). |
| `generate_image` | Images from text (Nano Banana 2, GPT Image 2.5, Muse Image). |
| `generate_audio` | Voiceover, multi-voice dialogue, music and sound effects. |
| `create_talking_video` | Talking photos and UGC-style ad videos with lip sync (HeyGen Avatar IV, OmniHuman 1.5). |
| `apply_effect` | Ready-made video effects on a photo: hug, dance, transformations. |
| `transfer_motion` | Moves a character photo the way a reference video moves (Kling Motion Control). |
| `upscale_video` | Upscales a video to 1080p or 4K, optionally to 60 fps (Topaz Video AI). |
| `create_explainer_video` | Narrated, captioned explainer video from a topic (Motif). |
| `run_template` | One-step video or image from a ready-made template. |

### Files and results (free)

| Tool | What it does |
|---|---|
| `upload_media` | Imports an image, video or audio file from a URL or an earlier result. |
| `get_generation` | A generation's status and, when done, its file links. Can wait for completion. |
| `list_generations` | Recent generations in your library. |
| `cancel_generation` | Cancels a queued generation and refunds its credits. |

### Account and catalog (free)

| Tool | What it does |
|---|---|
| `get_account` | Credit balance, plan and concurrent generation limit. |
| `list_models` | Models, what they can do and their credit prices. |
| `get_model` | Every setting, limit and example prompt for one model. |
| `estimate_cost` | Works out the credit cost before you generate. |
| `list_voices` | Voiceover voices with preview links. |
| `list_templates` | Ready-made templates and the fields they need. |

## Workflows (prompts)

| Prompt | Result |
|---|---|
| `product_ad` | Short ad video from a product photo. |
| `ugc_ad` | Presenter-led UGC ad: script plus talking video. |
| `storyboard_film` | Multi-shot short film from a script. |
| `photo_to_video` | Brings a photo to life. |
| `social_reel` | Vertical social video with music and captions. |
| `voiceover_pack` | Voiceover, music and sound effects from a script. |
| `character_consistency` | Several scenes with the same character. |

## Authentication

| Endpoint | URL |
|---|---|
| MCP server | `https://klakix.com/api/mcp` |
| Protected resource metadata (RFC 9728) | `https://klakix.com/.well-known/oauth-protected-resource` |
| Authorization server metadata (RFC 8414) | `https://klakix.com/.well-known/oauth-authorization-server` |
| Dynamic client registration (RFC 7591) | `POST https://klakix.com/api/oauth/register` |
| Token | `POST https://klakix.com/api/oauth/token` |
| Revocation (RFC 7009) | `POST https://klakix.com/api/oauth/revoke` |

- Authorization code flow with PKCE S256 only; no implicit flow, no `plain`.
- Scopes: `mcp:read` (balance, models, library) and `mcp:generate` (spends credits).
- Access tokens last 1 hour; refresh tokens rotate on every use and a reused refresh token revokes the connection.
- Supported MCP protocol versions: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.
- See and revoke connected apps and API keys at [klakix.com/app/mcp](https://klakix.com/app/mcp).

A request without a token gets `401` with a `WWW-Authenticate` header that points to the metadata, so OAuth-capable clients discover sign-in on their own.

## Pricing and limits

- Credits are shared with the website and never expire. Packs start at 75 credits for $5; see [klakix.com/pricing](https://klakix.com/pricing).
- Generations through MCP cost exactly what they cost on the website. A generation that fails for a technical reason or a safety block is refunded automatically.
- Parallel generations: 3 without a plan; 4, 6 or 10 on the plans.
- Video clips are 3 to 30 seconds depending on the model; results download as MP4, PNG or MP3.

## Safety

Every prompt and uploaded image goes through the same checks as the website. Celebrities, public figures, people without their consent and copyrighted characters are blocked; tools that use a photo of a person ask for a consent confirmation. There is no face swap and no voice cloning. Uploads are not used to train models.

## Build your own MCP server

The packages in this repository are the same code paths that serve `https://klakix.com/api/mcp`, without anything specific to our product (models, prices, moderation and storage live behind your own backend).

```bash
git clone https://github.com/klakix-ai/klakix-mcp.git
cd klakix-mcp
npm install
npm run build
npm start -w examples/self-hosted
```

Then connect a client to `http://localhost:8787/mcp`, for example `claude mcp add --transport http demo http://localhost:8787/mcp`, and sign in on the demo consent screen. A minimal server with one tool:

```ts
import { createMcpHandler, defineTool, toolOk } from "@klakix/mcp-server";
import { z } from "zod";

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Returns the text you send.",
  inputSchema: z.object({ text: z.string() }),
  handler: async ({ text }) => toolOk(text, { text }),
});

export const mcp = createMcpHandler({
  serverInfo: { name: "my-server", version: "1.0.0" },
  tools: [echo],
  authenticate: async (request) => (request.headers.get("authorization") === `Bearer ${process.env.API_KEY}` ? { id: "me" } : null),
});

// Any Fetch API runtime: export default { fetch: mcp.handle }
```

Read the package READMEs for OAuth wiring in Next.js, Node `http`, Hono and Cloudflare Workers.

## FAQ

**Can Claude generate images or videos?**
Not by itself. Claude writes text and code. With the Klakix connector, Claude calls image and video models (Nano Banana 2, GPT Image 2.5, Veo, Kling, Seedance) and returns the finished files in the chat. Guide: [Claude image generation](https://klakix.com/mcp/claude-image-generation), [Claude video generation](https://klakix.com/mcp/claude-video-generation).

**Can ChatGPT make videos?**
OpenAI shut down the Sora app in April 2026 and removed Sora 2 from its API in September 2026. ChatGPT can make videos through an MCP plugin such as Klakix, which runs Veo, Kling and Seedance. Guide: [ChatGPT video generator](https://klakix.com/mcp/chatgpt-video-generator).

**Do I need an API key?**
No for Claude, ChatGPT, Claude Code, Cursor, VS Code, Windsurf, Codex and Gemini CLI: they sign in with OAuth. Use an API key for clients without OAuth, such as n8n, Make or your own scripts.

**How is this different from the Higgsfield MCP?**
Both are remote MCP servers that sign in with OAuth and spend account credits. Klakix adds talking videos (HeyGen Avatar IV, OmniHuman), voiceovers, music and sound effects, Motif explainer videos and ready-made templates, and needs no subscription. Model-by-model comparison with prices: [klakix.com/higgsfield-alternative](https://klakix.com/higgsfield-alternative).

**Is the Klakix MCP server open source?**
Yes. The protocol layer, the OAuth 2.1 authorization server, the stdio bridge and the client configs are MIT-licensed in this repository. The generation backend (model routing, pricing, moderation, storage) is part of the hosted Klakix service.

**Which model should I use?**
Ask the assistant to call `list_models` and `estimate_cost`, or see the [model comparison](https://klakix.com/models).

## Links

- Website: [klakix.com](https://klakix.com)
- MCP page: [klakix.com/mcp](https://klakix.com/mcp)
- Models: [klakix.com/models](https://klakix.com/models)
- Agent Skills for AI video (camera angles, character consistency, Seedance prompts, lip sync): [klakix-ai/ai-video-skills](https://github.com/klakix-ai/ai-video-skills)
- Check generated clips before you use them (camera speed, flicker, frozen frames, cuts, audio): [klakix-ai/clipcheck](https://github.com/klakix-ai/clipcheck)
- AI video model prices per second, open dataset: [klakix-ai/ai-video-pricing](https://github.com/klakix-ai/ai-video-pricing)
- Support: support@klakix.com
- Turkish version of the product: [aivideoyap.com](https://aivideoyap.com) (server `https://aivideoyap.com/api/mcp`, same account)

Klakix is not affiliated with the companies that build the models; it gives access to them through API providers. Model names are trademarks of their owners.
