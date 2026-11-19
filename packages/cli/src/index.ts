#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`klakix-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
