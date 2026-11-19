export const DEFAULT_URL = "https://klakix.com/api/mcp";
export const DEFAULT_TIMEOUT_SECONDS = 600;

export interface CliConfig {
  apiKey: string | undefined;
  url: string;
  timeoutSeconds: number;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--api-key", "--url", "--timeout"]);

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): CliConfig {
  const config: CliConfig = {
    apiKey: undefined,
    url: DEFAULT_URL,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    verbose: false,
    help: false,
    version: false,
  };
  const envKey = env["KLAKIX_API_KEY"]?.trim();
  if (envKey) config.apiKey = envKey;
  const envUrl = env["KLAKIX_MCP_URL"]?.trim();
  if (envUrl) config.url = envUrl;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    let flag = arg;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    if (flag === "--help" || flag === "-h") config.help = true;
    else if (flag === "--version" || flag === "-v") config.version = true;
    else if (flag === "--verbose") config.verbose = true;
    else if (VALUE_FLAGS.has(flag)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`Missing value for ${flag}`);
      }
      if (flag === "--api-key") {
        if (value.trim() !== "") config.apiKey = value.trim();
      } else if (flag === "--url") {
        config.url = value.trim();
      } else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new UsageError("--timeout must be a positive number of seconds");
        }
        config.timeoutSeconds = seconds;
      }
    } else {
      throw new UsageError(`Unknown option: ${flag}`);
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new UsageError("The server URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError("The server URL must start with https:// or http://");
  }
  return config;
}

export function helpText(version: string): string {
  return `klakix-mcp ${version}

Bridges a stdio MCP client to the remote Klakix MCP server (Streamable HTTP).

Usage:
  npx -y klakix-mcp [options]

Options:
  --api-key <key>   Klakix API key (prefer the KLAKIX_API_KEY environment variable)
  --url <url>       Remote MCP endpoint (default ${DEFAULT_URL})
  --timeout <sec>   Per-request timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS})
  --verbose         Write diagnostics to stderr
  -h, --help        Show this help
  -v, --version     Show the version

Environment:
  KLAKIX_API_KEY    API key, created at https://klakix.com/app/mcp
  KLAKIX_MCP_URL    Remote MCP endpoint

Docs: https://klakix.com/mcp
`;
}
