import { escapeXml as escapeHtml } from "./art.ts";

interface ConsentView {
  clientName: string;
  clientUri: string | null;
  registrationType: string;
  redirectDisplay: string;
  scopes: Array<{ name: string; description: string }>;
  consentToken: string;
  userLabel: string;
  action: string;
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px; background: #f6f6f4; color: #1b1b1b; }
@media (prefers-color-scheme: dark) { body { background: #151515; color: #ececec; } .card { background: #1f1f1f; border-color: #333; } .muted { color: #9a9a9a; } }
.card { max-width: 440px; margin: 40px auto; padding: 28px; background: #fff; border: 1px solid #ddd; border-radius: 12px; }
h1 { font-size: 20px; margin: 0 0 12px; }
ul { padding-left: 20px; }
li { margin: 6px 0; }
code { font: 14px ui-monospace, monospace; }
.muted { color: #666; font-size: 14px; }
.row { display: flex; gap: 12px; margin-top: 24px; }
button { flex: 1; padding: 10px 14px; font: inherit; border-radius: 8px; border: 1px solid #888; background: transparent; color: inherit; cursor: pointer; }
button.primary { background: #1b1b1b; color: #fff; border-color: #1b1b1b; }
@media (prefers-color-scheme: dark) { button.primary { background: #ececec; color: #151515; border-color: #ececec; } }
`;

export function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>
`;
}

export function consentPage(view: ConsentView): string {
  const scopes = view.scopes.map((s) => `<li>${escapeHtml(s.description || s.name)} <code>${escapeHtml(s.name)}</code></li>`).join("\n");
  const unverified = view.registrationType === "dynamic" ? '<p class="muted">This application registered itself. Only continue if you started this connection.</p>' : "";
  return htmlPage(
    "Connect an application",
    `<h1>${escapeHtml(view.clientName)} wants to connect</h1>
<p class="muted">Signed in as <strong>${escapeHtml(view.userLabel)}</strong>. This example has a single built-in account.</p>
<p>It will be allowed to:</p>
<ul>
${scopes}
</ul>
<p class="muted">After you decide, you are sent to <strong>${escapeHtml(view.redirectDisplay)}</strong>.</p>
${unverified}
<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="consent" value="${escapeHtml(view.consentToken)}">
<div class="row">
<button type="submit" name="decision" value="deny">Cancel</button>
<button type="submit" name="decision" value="approve" class="primary">Allow</button>
</div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return htmlPage("Request not valid", `<h1>This request cannot be completed</h1>\n<p>${escapeHtml(message)}</p>\n<p class="muted">Return to the application and start the connection again.</p>`);
}

export function homePage(issuer: string): string {
  return htmlPage(
    "Self-hosted MCP server",
    `<h1>Self-hosted MCP server</h1>
<p>This is the Klakix MCP example. Point an MCP client at:</p>
<p><code>${escapeHtml(issuer)}/mcp</code></p>
<p class="muted">Metadata: <code>${escapeHtml(issuer)}/.well-known/oauth-protected-resource/mcp</code></p>`,
  );
}

/** Security headers for every HTML page. The consent page must never be framed. */
export const HTML_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
