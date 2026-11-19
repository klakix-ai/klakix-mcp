# Contributing

Thanks for helping with Klakix MCP. This repository is an npm workspaces monorepo:

| Path | Package |
| --- | --- |
| `packages/cli` | `klakix-mcp`, the stdio bridge |
| `packages/mcp-server` | `@klakix/mcp-server` |
| `packages/mcp-oauth` | `@klakix/mcp-oauth` |
| `examples/self-hosted` | Runnable example, not published |

## Setup

You need Node.js 20 or newer (22.18 or newer for the example's `npm start`) and npm 10.

```sh
npm ci
npm run build
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compiles all packages and the example with `tsc -b`, in dependency order. |
| `npm run typecheck` | Type checks the sources and tests of every package without emitting. Needs no build. |
| `npm test` | Runs all tests with Vitest, including the end-to-end test of the example. Needs no build. |
| `npm run lint` | Alias of `typecheck`. |

CI runs `build`, `typecheck` and `test` on Node 20 and 22, and builds the Docker image. Run the three commands before you open a pull request.

To run the tests of one package: `npx vitest run packages/mcp-oauth`. To try the example: `npm start -w examples/self-hosted` (see its [README](examples/self-hosted/README.md)).

## Pull requests

- Keep a pull request to one change. Open an issue first for anything that changes a public API or the OAuth behavior.
- Add or update tests with the change. Security relevant behavior (redirect URI matching, PKCE, token rotation, SSRF checks) needs a test that fails without the fix.
- Public exports of `@klakix/mcp-server` and `@klakix/mcp-oauth` follow semver. Call out breaking changes in the pull request and add a line to `CHANGELOG.md`.
- `@klakix/mcp-oauth` and `klakix-mcp` have no runtime dependencies, and `@klakix/mcp-server` has only `zod`. Discuss any new dependency in an issue first.
- Write documentation and code comments in plain English. Update the package README when behavior or options change.
- Never include real API keys, tokens or customer data in tests, fixtures or issues.

## Reporting security problems

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the MIT license of this repository.
