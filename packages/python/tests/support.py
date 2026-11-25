"""Shared test helpers: import path, a fake MCP server and a bridge runner."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Union

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# The fake server is on loopback; never route it through a system proxy.
for _name in ("NO_PROXY", "no_proxy"):
    os.environ[_name] = "127.0.0.1,localhost"

from klakix_mcp.bridge import Bridge  # noqa: E402

KEY = "avy_sk_test_secret_value"

# A responder gets the handler (for headers and writing) and the parsed body.
Responder = Callable[["Handler", Any], None]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # the body ends when the connection closes

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        body = json.loads(raw.decode("utf-8"))
        headers = {k.lower(): v for k, v in self.headers.items()}
        self.server.calls.append({"headers": headers, "body": body, "path": self.path})  # type: ignore[attr-defined]
        self.server.responder(self, body)  # type: ignore[attr-defined]

    # Reply helpers -----------------------------------------------------

    def send_json(self, body: Any, status: int = 200, headers: Optional[Dict[str, str]] = None) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def send_text(self, text: str, status: int = 200, content_type: str = "text/plain") -> None:
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_sse(self, chunks: Iterable[Union[str, float]]) -> None:
        """Streams chunks; a number in the sequence means sleep that many seconds."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk in chunks:
            if isinstance(chunk, (int, float)):
                time.sleep(chunk)
                continue
            self.wfile.write(chunk.encode("utf-8"))
            self.wfile.flush()


class FakeServer:
    def __init__(self, responder: Responder) -> None:
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.httpd.calls = []  # type: ignore[attr-defined]
        self.httpd.responder = responder  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/api/mcp"

    @property
    def calls(self) -> List[Dict[str, Any]]:
        return self.httpd.calls  # type: ignore[attr-defined]

    def __enter__(self) -> "FakeServer":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class Result:
    def __init__(self, calls: List[Dict[str, Any]], raw: List[str], logs: List[str]) -> None:
        self.calls = calls
        self.raw = raw
        self.logs = logs
        self.out = [json.loads(line) for line in raw]


def run_bridge(
    responder: Responder,
    lines: Iterable[Union[str, bytes]],
    api_key: Optional[str] = KEY,
    timeout: float = 5.0,
    url: Optional[str] = None,
) -> Result:
    """Runs a Bridge against a fake server. Strings in `lines` get a trailing newline."""
    raw: List[str] = []
    logs: List[str] = []
    prepared = [item + "\n" if isinstance(item, str) else item for item in lines]
    with FakeServer(responder) as server:
        bridge = Bridge(
            url=url or server.url,
            api_key=api_key,
            timeout=timeout,
            user_agent="klakix-mcp/9.9.9",
            input=prepared,
            write=raw.append,
            log=logs.append,
        )
        bridge.run()
        calls = list(server.calls)
    return Result(calls, raw, logs)


def dumps(message: Any) -> str:
    return json.dumps(message)


INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}
LIST_TOOLS = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
INIT_RESULT = {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-03-26", "capabilities": {}}}
