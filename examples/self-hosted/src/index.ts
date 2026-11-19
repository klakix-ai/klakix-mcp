import { randomBytes } from "node:crypto";
import { startServer } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);
const issuer = process.env.ISSUER ?? `http://localhost:${port}`;

let consentSecret = process.env.OAUTH_CONSENT_SECRET;
if (!consentSecret) {
  consentSecret = randomBytes(32).toString("hex");
  console.log("OAUTH_CONSENT_SECRET is not set; using a random secret. Pending consent screens stop working on restart.");
}

const running = await startServer({
  port,
  host: process.env.HOST ?? "127.0.0.1",
  issuer,
  consentSecret,
  ...(process.env.DEMO_API_KEY ? { apiKey: process.env.DEMO_API_KEY } : {}),
});

console.log(`MCP server:        ${running.issuer}/mcp`);
console.log(`Resource metadata: ${running.issuer}/.well-known/oauth-protected-resource/mcp`);
console.log(process.env.DEMO_API_KEY ? "API key sign-in:   enabled (DEMO_API_KEY)" : "API key sign-in:   disabled (set DEMO_API_KEY to enable)");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
