# Stdio bridge to the remote Klakix MCP server (the klakix-mcp package).
#
#   docker build -t klakix-mcp .
#   docker run -i --rm -e KLAKIX_API_KEY=avy_sk_... klakix-mcp
#
# The MCP client talks to the container over stdin/stdout, so keep -i.

FROM node:22-alpine AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/cli packages/cli
# The CLI has no runtime dependencies; only the compiler is needed to build it.
RUN npm install --no-save --no-audit --no-fund --no-package-lock typescript@5.9.3 @types/node@22 \
 && npx tsc -p packages/cli

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/packages/cli/package.json packages/cli/package.json
COPY --from=build /app/packages/cli/dist packages/cli/dist
USER node
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
