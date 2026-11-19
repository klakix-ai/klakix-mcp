# Changelog

All notable changes to this repository are listed here. The three packages are versioned together.

## 0.1.0 - 2026-11-19

First release.

### Added

- `klakix-mcp`: stdio bridge that connects Claude Desktop and other stdio MCP clients to the remote Klakix MCP server. No dependencies; configured with `KLAKIX_API_KEY`, `KLAKIX_MCP_URL` or command-line flags.
- `@klakix/mcp-server`: stateless Streamable HTTP MCP server for the Web Fetch API. Tools with zod schemas, prompts, resources, tool scopes, authentication, authorization, rate limit and call logging hooks, and `fetchRemoteMedia`, an SSRF-safe media downloader.
- `@klakix/mcp-oauth`: OAuth 2.1 authorization server for remote MCP servers. PKCE S256, dynamic client registration, Client ID Metadata Documents with SSRF protection, authorization server and protected resource metadata, refresh token rotation with reuse detection, revocation, and a storage interface with an in-memory implementation.
- `examples/self-hosted`: runnable server that combines both libraries, with a consent page, an API key path, demo tools, a prompt, a resource and an end-to-end test.
- Dockerfile for the stdio bridge, and a CI workflow that builds, type checks and tests on Node 20 and 22.
