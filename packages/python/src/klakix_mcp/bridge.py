"""stdio to Streamable HTTP bridge for MCP.

Reads newline-delimited JSON-RPC from an input iterable, POSTs every message
to a remote MCP endpoint and writes each JSON-RPC message it gets back as one
line. Input and output are injected so the bridge is testable. Standard
library only.
"""

from __future__ import annotations

import codecs
import json
import math
import re
import socket
import threading
import urllib.error
import urllib.request
from typing import Any, Callable, Iterable, List, Optional, Set, Union
from urllib.parse import urlsplit

ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_INTERNAL = -32603
ERR_AUTH = -32001

AUTH_MESSAGE = (
    "Klakix API key required. Create one at https://klakix.com/app/mcp and set it in "
    "the KLAKIX_API_KEY environment variable of this MCP server entry."
)

JsonRpcId = Union[str, int, float, None]


def _reject_constant(name: str) -> Any:
    raise ValueError(f"invalid JSON constant {name}")


def _parse_json(text: str) -> Any:
    """json.loads that, like JSON.parse, rejects NaN and Infinity."""
    return json.loads(text, parse_constant=_reject_constant)


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _is_id(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        return math.isfinite(value)
    return isinstance(value, (str, int))


def _is_request(message: Any) -> bool:
    return (
        _is_object(message)
        and isinstance(message.get("method"), str)
        and _is_id(message.get("id"))
    )


def _items(payload: Any) -> List[Any]:
    return payload if isinstance(payload, list) else [payload]


def _request_ids(payload: Any) -> List[Any]:
    return [item["id"] for item in _items(payload) if _is_request(item)]


def _has_method(payload: Any, method: str) -> bool:
    return any(_is_request(item) and item["method"] == method for item in _items(payload))


def _find_socket(response: Any) -> Optional[socket.socket]:
    obj = response
    for _ in range(5):
        sock = getattr(obj, "_sock", None)
        if isinstance(sock, socket.socket):
            return sock
        nxt = getattr(obj, "fp", None) or getattr(obj, "raw", None)
        if nxt is None or nxt is obj:
            return None
        obj = nxt
    return None


class _InFlight:
    """State of one running request, so it can be aborted from another thread."""

    def __init__(self) -> None:
        self.response: Any = None
        self.timed_out = False
        self._lock = threading.Lock()

    def attach(self, response: Any) -> None:
        with self._lock:
            self.response = response
        if self.timed_out:
            self.abort()

    def expire(self) -> None:
        self.timed_out = True
        self.abort()

    def abort(self) -> None:
        with self._lock:
            response = self.response
        if response is None:
            return
        try:
            sock = _find_socket(response)
            if sock is not None:
                sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class _RedirectHandler(urllib.request.HTTPRedirectHandler):
    """Like fetch: keep method and body on 307/308, drop the key when the host changes."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if code in (307, 308):
            new_headers = {
                k: v
                for k, v in req.headers.items()
                if k.lower() not in ("content-length", "host")
            }
            new_req = urllib.request.Request(
                newurl,
                data=req.data,
                headers=new_headers,
                origin_req_host=req.origin_req_host,
                unverifiable=True,
                method=req.get_method(),
            )
        else:
            new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None:
            old_host = (urlsplit(req.full_url).netloc or "").lower()
            new_host = (urlsplit(newurl).netloc or "").lower()
            if old_host != new_host:
                for name in list(new_req.headers):
                    if name.lower() == "authorization":
                        del new_req.headers[name]
        return new_req


_OPENER = urllib.request.build_opener(_RedirectHandler)


def _round_half_up(value: float) -> int:
    return int(math.floor(value + 0.5))


def _is_timeout(error: BaseException) -> bool:
    if isinstance(error, (socket.timeout, TimeoutError)):
        return True
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, (socket.timeout, TimeoutError))
    return False


def _describe(error: BaseException) -> str:
    if isinstance(error, urllib.error.URLError) and not isinstance(error, urllib.error.HTTPError):
        return str(error.reason) or error.__class__.__name__
    return str(error) or error.__class__.__name__


class Bridge:
    def __init__(
        self,
        url: str,
        timeout: float,
        user_agent: str,
        input: Iterable[Union[str, bytes]],
        write: Callable[[str], None],
        api_key: Optional[str] = None,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        """
        url: remote MCP endpoint, for example https://klakix.com/api/mcp.
        timeout: per-request timeout in seconds.
        user_agent: value of the User-Agent header, for example klakix-mcp/0.1.0.
        input: chunks of stdin (str or bytes). Exhaustion means no more messages.
        write: writes one complete line (no trailing newline) to stdout.
        api_key: bearer token. Never logged or written to the output.
        log: diagnostic sink (stderr), called only when provided.
        """
        self._url = url
        self._timeout = timeout
        self._user_agent = user_agent
        self._input = input
        self._write = write
        self._api_key = api_key
        self._log_sink = log

        self._closed = False
        self._protocol_version: Optional[str] = None
        self._session_id: Optional[str] = None
        self._state_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending: Set[threading.Thread] = set()
        self._pending_lock = threading.Lock()
        self._in_flight: Set[_InFlight] = set()
        # Later requests wait until the initialize round trip has finished.
        self._gate = threading.Event()
        self._gate.set()

    # Output -----------------------------------------------------------

    def _redact(self, text: str) -> str:
        if self._api_key:
            return text.replace(self._api_key, "[redacted]")
        return text

    def _log(self, message: str) -> None:
        if self._log_sink is not None:
            self._log_sink(self._redact(message))

    def _emit(self, message: Any) -> None:
        if self._closed:
            return
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            if self._closed:
                return
            self._write(line)

    def _emit_error(self, id_: JsonRpcId, code: int, message: str) -> None:
        self._emit({"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": self._redact(message)}})

    def _fail_requests(self, payload: Any, code: int, message: str) -> None:
        for id_ in _request_ids(payload):
            self._emit_error(id_, code, message)

    def _emit_server_payload(self, payload: Any, saw_initialize: bool) -> None:
        for item in _items(payload):
            if not _is_object(item):
                continue
            if saw_initialize and _is_object(item.get("result")):
                version = item["result"].get("protocolVersion")
                if isinstance(version, str):
                    with self._state_lock:
                        self._protocol_version = version
            self._emit(item)

    # Server-sent events -----------------------------------------------

    def _read_sse(self, response: Any, saw_initialize: bool, state: _InFlight) -> None:
        reader = getattr(response, "read1", None) or response.read
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        buffer = ""
        data_lines: List[str] = []

        def dispatch() -> None:
            nonlocal data_lines
            if not data_lines:
                return
            data = "\n".join(data_lines)
            data_lines = []
            if data.strip() == "":
                return
            try:
                parsed = _parse_json(data)
            except ValueError:
                self._log("ignored an SSE event that is not valid JSON")
                return
            self._emit_server_payload(parsed, saw_initialize)

        def process_line(line: str) -> None:
            if line == "":
                dispatch()
                return
            if line.startswith(":"):
                return
            colon = line.find(":")
            field = line if colon == -1 else line[:colon]
            value = "" if colon == -1 else line[colon + 1 :]
            if value.startswith(" "):
                value = value[1:]
            if field == "data":
                data_lines.append(value)

        def drain(final: bool) -> None:
            nonlocal buffer
            text = buffer
            held = ""
            if not final and text.endswith("\r"):
                held = "\r"
                text = text[:-1]
            text = re.sub(r"\r\n?", "\n", text)
            lines = text.split("\n")
            rest = lines.pop()
            for line in lines:
                process_line(line)
            if final and rest != "":
                process_line(rest)
            buffer = "" if final else rest + held

        while True:
            chunk = reader(65536)
            if not chunk:
                break
            buffer += decoder.decode(chunk)
            drain(False)
            if self._closed:
                return
            if state.timed_out:
                raise socket.timeout("timed out")
        if state.timed_out:
            raise socket.timeout("timed out")
        buffer += decoder.decode(b"", final=True)
        drain(True)
        dispatch()

    # HTTP -------------------------------------------------------------

    def _post(self, payload: Any) -> None:
        saw_initialize = _has_method(payload, "initialize")
        state = _InFlight()
        with self._state_lock:
            self._in_flight.add(state)
            protocol_version = self._protocol_version
            session_id = self._session_id
        timer = threading.Timer(self._timeout, state.expire)
        timer.daemon = True
        timer.start()

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": self._user_agent,
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if protocol_version and not saw_initialize:
            headers["MCP-Protocol-Version"] = protocol_version
        if session_id:
            headers["Mcp-Session-Id"] = session_id

        try:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            request = urllib.request.Request(self._url, data=body, headers=headers, method="POST")
            try:
                response = _OPENER.open(request, timeout=self._timeout)
            except urllib.error.HTTPError as http_error:
                response = http_error  # an HTTPError is also a readable response
            state.attach(response)
            try:
                self._handle_response(response, payload, saw_initialize, state)
            finally:
                try:
                    response.close()
                except Exception:  # noqa: BLE001
                    pass
        except Exception as error:  # noqa: BLE001
            if self._closed:
                return
            if state.timed_out or _is_timeout(error):
                self._fail_requests(
                    payload,
                    ERR_INTERNAL,
                    "Request to the Klakix MCP server timed out after "
                    f"{_round_half_up(self._timeout)} seconds",
                )
                return
            detail = _describe(error)
            self._log(f"request failed: {detail}")
            self._fail_requests(payload, ERR_INTERNAL, f"Could not reach the Klakix MCP server: {detail}")
        finally:
            timer.cancel()
            with self._state_lock:
                self._in_flight.discard(state)

    def _handle_response(self, response: Any, payload: Any, saw_initialize: bool, state: _InFlight) -> None:
        status = response.getcode()
        self._log(f"POST {self._url} -> {status}")

        session = response.headers.get("mcp-session-id")
        if session:
            with self._state_lock:
                self._session_id = session

        if status in (202, 204):
            return
        if status == 401:
            self._fail_requests(payload, ERR_AUTH, AUTH_MESSAGE)
            return

        content_type = (response.headers.get("content-type") or "").lower()
        ok = 200 <= status < 300

        if ok and "text/event-stream" in content_type:
            self._read_sse(response, saw_initialize, state)
            return

        raw = response.read()
        if state.timed_out:
            raise socket.timeout("timed out")
        text = raw.decode("utf-8", errors="replace")

        if not ok:
            # A JSON-RPC error body from the server is more useful than a generic one.
            if "json" in content_type:
                try:
                    parsed = _parse_json(text)
                except ValueError:
                    parsed = None
                else:
                    items = _items(parsed)
                    if items and all(_is_object(i) and "jsonrpc" in i for i in items):
                        self._emit_server_payload(parsed, False)
                        return
            snippet = re.sub(r"\s+", " ", text).strip()[:200]
            suffix = f": {snippet}" if snippet else ""
            self._fail_requests(
                payload, ERR_INTERNAL, f"Klakix MCP server returned HTTP {status}{suffix}"
            )
            return

        if text.strip() == "":
            return
        try:
            parsed = _parse_json(text)
        except ValueError:
            self._fail_requests(
                payload, ERR_INTERNAL, "Klakix MCP server returned a response that is not valid JSON"
            )
            return
        self._emit_server_payload(parsed, saw_initialize)

    # Scheduling -------------------------------------------------------

    def _track(self, target: Callable[[], None]) -> None:
        def runner() -> None:
            try:
                target()
            except Exception as error:  # noqa: BLE001
                self._log(f"unexpected error: {error}")
            finally:
                with self._pending_lock:
                    self._pending.discard(threading.current_thread())

        thread = threading.Thread(target=runner, name="klakix-mcp-request", daemon=True)
        with self._pending_lock:
            self._pending.add(thread)
        thread.start()

    def _dispatch_payload(self, payload: Any) -> None:
        if _has_method(payload, "initialize"):
            gate = threading.Event()
            self._gate = gate

            def initialize() -> None:
                try:
                    self._post(payload)
                finally:
                    gate.set()

            self._track(initialize)
            return

        wait = self._gate

        def later() -> None:
            wait.wait()
            if self._closed:
                return
            self._post(payload)

        self._track(later)

    def _handle_line(self, raw: str) -> None:
        line = raw.strip()
        if line == "":
            return
        try:
            payload = _parse_json(line)
        except ValueError:
            self._emit_error(None, ERR_PARSE, "Parse error: input line is not valid JSON")
            return
        if isinstance(payload, list):
            valid = len(payload) > 0 and all(_is_object(p) for p in payload)
        else:
            valid = _is_object(payload)
        if not valid:
            self._emit_error(None, ERR_INVALID_REQUEST, "Invalid request: expected a JSON-RPC message object")
            return
        self._dispatch_payload(payload)

    def run(self) -> None:
        """Returns when input has ended and every pending request has finished."""
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        buffer = ""
        for chunk in self._input:
            if self._closed:
                break
            buffer += chunk if isinstance(chunk, str) else decoder.decode(chunk)
            newline = buffer.find("\n")
            while newline != -1:
                self._handle_line(buffer[:newline])
                buffer = buffer[newline + 1 :]
                newline = buffer.find("\n")
        if not self._closed:
            buffer += decoder.decode(b"", final=True)
            self._handle_line(buffer)
        while True:
            with self._pending_lock:
                threads = list(self._pending)
            if not threads:
                break
            for thread in threads:
                thread.join()

    def close(self) -> None:
        """Aborts in-flight requests and stops reading. Writes nothing more."""
        self._closed = True
        with self._state_lock:
            states = list(self._in_flight)
        for state in states:
            state.abort()
