"""Command-line entry point: `klakix-mcp` and `python -m klakix_mcp`."""

from __future__ import annotations

import os
import signal
import sys
from typing import Iterator, List, Mapping, Optional

from . import __version__
from .args import UsageError, help_text, parse_args
from .bridge import Bridge


def _stdin_chunks() -> Iterator[bytes]:
    """Yields stdin bytes as they arrive; os.read returns as soon as data is there."""
    fd = sys.stdin.fileno()
    while True:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        yield chunk


def main(argv: Optional[List[str]] = None, env: Optional[Mapping[str, str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if env is None:
        env = os.environ

    try:
        config = parse_args(list(argv), env)
    except UsageError as error:
        sys.stderr.write(f"klakix-mcp: {error}\nRun klakix-mcp --help for usage.\n")
        return 2
    if config.help:
        sys.stdout.write(help_text(__version__))
        sys.stdout.flush()
        return 0
    if config.version:
        sys.stdout.write(f"{__version__}\n")
        sys.stdout.flush()
        return 0

    stdout = sys.stdout.buffer
    holder: List[Bridge] = []

    def write(line: str) -> None:
        try:
            data = line.encode("utf-8")
        except UnicodeEncodeError:
            data = line.encode("utf-8", errors="backslashreplace")
        try:
            stdout.write(data + b"\n")
            stdout.flush()
        except (BrokenPipeError, OSError):
            # The client went away: stop writing and let the process end.
            for bridge in holder:
                bridge.close()

    def log(message: str) -> None:
        sys.stderr.write(f"[klakix-mcp] {message}\n")
        sys.stderr.flush()

    bridge = Bridge(
        url=config.url,
        api_key=config.api_key,
        timeout=config.timeout_seconds,
        user_agent=f"klakix-mcp/{__version__}",
        input=_stdin_chunks(),
        write=write,
        log=log if config.verbose else None,
    )
    holder.append(bridge)

    def stop(signum: int, frame: object) -> None:
        bridge.close()
        os._exit(0)

    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, stop)
            except (ValueError, OSError):
                pass

    try:
        bridge.run()
    except KeyboardInterrupt:
        bridge.close()
    except Exception as error:  # noqa: BLE001
        sys.stderr.write(f"klakix-mcp: {error}\n")
        return 1
    return 0
