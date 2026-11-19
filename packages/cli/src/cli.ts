import { readFileSync } from "node:fs";
import { createBridge } from "./bridge.js";
import { helpText, parseArgs, UsageError } from "./args.js";
import type { CliConfig } from "./args.js";

function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === "string") return version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const version = readVersion();
  let config: CliConfig;
  try {
    config = parseArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`klakix-mcp: ${error.message}\nRun klakix-mcp --help for usage.\n`);
      return 2;
    }
    throw error;
  }
  if (config.help) {
    process.stdout.write(helpText(version));
    return 0;
  }
  if (config.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const bridge = createBridge({
    url: config.url,
    apiKey: config.apiKey,
    timeoutMs: Math.round(config.timeoutSeconds * 1000),
    userAgent: `klakix-mcp/${version}`,
    fetch: globalThis.fetch,
    input: process.stdin,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    log: config.verbose
      ? (message) => {
          process.stderr.write(`[klakix-mcp] ${message}\n`);
        }
      : undefined,
  });

  const stop = (): void => {
    bridge.close();
    // Let stdout flush briefly, then leave even if stdin stays open.
    setTimeout(() => process.exit(0), 50).unref();
    process.stdin.destroy();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bridge.run();
  return 0;
}
