"""Command-line flags and environment variables."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Mapping, Optional
from urllib.parse import urlsplit

DEFAULT_URL = "https://klakix.com/api/mcp"
DEFAULT_TIMEOUT_SECONDS = 600.0


@dataclass
class CliConfig:
    api_key: Optional[str] = None
    url: str = DEFAULT_URL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    verbose: bool = False
    help: bool = False
    version: bool = False


class UsageError(Exception):
    """Raised for bad command-line input."""


_VALUE_FLAGS = {"--api-key", "--url", "--timeout"}


def _check_url(url: str) -> None:
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
    except ValueError:
        raise UsageError("The server URL is not a valid URL") from None
    if not parts.scheme:
        raise UsageError("The server URL is not a valid URL")
    if parts.scheme.lower() not in ("http", "https"):
        raise UsageError("The server URL must start with https:// or http://")
    if not hostname:
        raise UsageError("The server URL is not a valid URL")


def parse_args(argv: List[str], env: Mapping[str, Optional[str]]) -> CliConfig:
    config = CliConfig()
    env_key = (env.get("KLAKIX_API_KEY") or "").strip()
    if env_key:
        config.api_key = env_key
    env_url = (env.get("KLAKIX_MCP_URL") or "").strip()
    if env_url:
        config.url = env_url

    i = 0
    while i < len(argv):
        arg = argv[i]
        i += 1
        flag = arg
        value: Optional[str] = None
        eq = arg.find("=")
        if arg.startswith("--") and eq != -1:
            flag = arg[:eq]
            value = arg[eq + 1 :]
        if flag in ("--help", "-h"):
            config.help = True
        elif flag in ("--version", "-v"):
            config.version = True
        elif flag == "--verbose":
            config.verbose = True
        elif flag in _VALUE_FLAGS:
            if value is None:
                if i >= len(argv):
                    raise UsageError(f"Missing value for {flag}")
                value = argv[i]
                i += 1
            if flag == "--api-key":
                if value.strip() != "":
                    config.api_key = value.strip()
            elif flag == "--url":
                config.url = value.strip()
            else:
                try:
                    seconds = float(value)
                except ValueError:
                    seconds = math.nan
                if not math.isfinite(seconds) or seconds <= 0:
                    raise UsageError("--timeout must be a positive number of seconds")
                config.timeout_seconds = seconds
        else:
            raise UsageError(f"Unknown option: {flag}")

    _check_url(config.url)
    return config


def help_text(version: str) -> str:
    return f"""klakix-mcp {version}

Bridges a stdio MCP client to the remote Klakix MCP server (Streamable HTTP).

Usage:
  uvx klakix-mcp [options]

Options:
  --api-key <key>   Klakix API key (prefer the KLAKIX_API_KEY environment variable)
  --url <url>       Remote MCP endpoint (default {DEFAULT_URL})
  --timeout <sec>   Per-request timeout in seconds (default {int(DEFAULT_TIMEOUT_SECONDS)})
  --verbose         Write diagnostics to stderr
  -h, --help        Show this help
  -v, --version     Show the version

Environment:
  KLAKIX_API_KEY    API key, created at https://klakix.com/app/mcp
  KLAKIX_MCP_URL    Remote MCP endpoint

Docs: https://klakix.com/mcp
"""
