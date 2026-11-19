import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_SECONDS, DEFAULT_URL, helpText, parseArgs, UsageError } from "../src/args.js";

describe("parseArgs", () => {
  it("uses defaults", () => {
    const config = parseArgs([], {});
    expect(config.url).toBe(DEFAULT_URL);
    expect(config.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(config.apiKey).toBeUndefined();
    expect(config.verbose).toBe(false);
  });

  it("reads the environment", () => {
    const config = parseArgs([], { KLAKIX_API_KEY: "avy_sk_x", KLAKIX_MCP_URL: "http://localhost:3000/api/mcp" });
    expect(config.apiKey).toBe("avy_sk_x");
    expect(config.url).toBe("http://localhost:3000/api/mcp");
  });

  it("lets flags override the environment, in both flag styles", () => {
    const config = parseArgs(["--api-key", "flag_key", "--url=https://example.com/mcp", "--timeout", "30", "--verbose"], {
      KLAKIX_API_KEY: "env_key",
    });
    expect(config.apiKey).toBe("flag_key");
    expect(config.url).toBe("https://example.com/mcp");
    expect(config.timeoutSeconds).toBe(30);
    expect(config.verbose).toBe(true);
  });

  it("recognises help and version", () => {
    expect(parseArgs(["--help"], {}).help).toBe(true);
    expect(parseArgs(["-v"], {}).version).toBe(true);
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--nope"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--timeout", "0"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--timeout"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--url", "ftp://x"], {})).toThrow(UsageError);
    expect(() => parseArgs(["--url", "not a url"], {})).toThrow(UsageError);
  });

  it("help text has no exclamation marks and names every option", () => {
    const text = helpText("1.2.3");
    expect(text).not.toContain("!");
    for (const flag of ["--api-key", "--url", "--timeout", "--verbose", "--help", "--version", "KLAKIX_API_KEY", "KLAKIX_MCP_URL"]) {
      expect(text).toContain(flag);
    }
  });
});
