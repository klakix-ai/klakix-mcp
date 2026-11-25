import json
import threading
import time
import unittest

import support
from support import (
    INIT,
    INIT_RESULT,
    INITIALIZED,
    KEY,
    LIST_TOOLS,
    dumps,
    run_bridge,
)
from klakix_mcp.bridge import AUTH_MESSAGE


def method_of(call):
    return call["body"]["method"]


def ok_for(handler, body):
    """Answers any request with an empty result carrying its own id."""
    handler.send_json({"jsonrpc": "2.0", "id": body.get("id"), "result": {}})


class HeadersTest(unittest.TestCase):
    def test_sends_expected_headers_and_negotiated_protocol_version(self):
        def responder(handler, body):
            if body["method"] == "initialize":
                handler.send_json(INIT_RESULT)
            elif body["method"] == "tools/list":
                handler.send_json({"jsonrpc": "2.0", "id": 2, "result": {"tools": []}})
            else:
                handler.send_empty(202)

        result = run_bridge(responder, [dumps(INIT), dumps(INITIALIZED), dumps(LIST_TOOLS)])
        self.assertEqual(len(result.calls), 3)
        first = result.calls[0]
        self.assertEqual(first["path"], "/api/mcp")
        self.assertEqual(first["headers"]["content-type"], "application/json")
        self.assertEqual(first["headers"]["accept"], "application/json, text/event-stream")
        self.assertEqual(first["headers"]["authorization"], f"Bearer {KEY}")
        self.assertEqual(first["headers"]["user-agent"], "klakix-mcp/9.9.9")
        self.assertNotIn("mcp-protocol-version", first["headers"])
        for later in result.calls[1:]:
            self.assertEqual(later["headers"]["mcp-protocol-version"], "2025-03-26")
        self.assertEqual(result.out, [INIT_RESULT, {"jsonrpc": "2.0", "id": 2, "result": {"tools": []}}])

    def test_echoes_session_id_returned_by_server(self):
        def responder(handler, body):
            if body["method"] == "initialize":
                handler.send_json(INIT_RESULT, headers={"Mcp-Session-Id": "sess-1"})
            else:
                ok_for(handler, body)

        result = run_bridge(responder, [dumps(INIT), dumps(LIST_TOOLS)])
        self.assertNotIn("mcp-session-id", result.calls[0]["headers"])
        self.assertEqual(result.calls[1]["headers"]["mcp-session-id"], "sess-1")

    def test_omits_authorization_without_key(self):
        result = run_bridge(ok_for, [dumps(LIST_TOOLS)], api_key=None)
        self.assertNotIn("authorization", result.calls[0]["headers"])


class GateTest(unittest.TestCase):
    def test_later_requests_wait_for_initialize_response(self):
        events = []

        def responder(handler, body):
            if body["method"] == "initialize":
                events.append("init:received")
                time.sleep(0.3)
                events.append("init:answering")
                handler.send_json(INIT_RESULT)
            else:
                events.append(f"{body['method']}:received")
                ok_for(handler, body)

        result = run_bridge(responder, [dumps(INIT), dumps(LIST_TOOLS), dumps(INITIALIZED)])
        self.assertEqual(
            events[:3], ["init:received", "init:answering", "tools/list:received"], events
        )
        self.assertEqual(sorted(events[2:]), ["notifications/initialized:received", "tools/list:received"])
        for later in result.calls[1:]:
            self.assertEqual(later["headers"]["mcp-protocol-version"], "2025-03-26")


class ResponseTest(unittest.TestCase):
    def test_requests_run_concurrently_and_responses_arrive_in_any_order(self):
        slow = {"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "slow"}}
        fast = {"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "fast"}}

        def responder(handler, body):
            if body["id"] == 10:
                time.sleep(0.4)
            handler.send_json({"jsonrpc": "2.0", "id": body["id"], "result": {"ok": body["id"]}})

        result = run_bridge(responder, [dumps(slow), dumps(fast)])
        self.assertEqual([m["id"] for m in result.out], [11, 10])

    def test_batched_json_response_is_one_message_per_line(self):
        batch = [
            {"jsonrpc": "2.0", "id": 1, "result": {"a": 1}},
            {"jsonrpc": "2.0", "id": 2, "result": {"b": 2}},
        ]
        request = [
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "id": 2, "method": "ping"},
        ]
        result = run_bridge(lambda h, b: h.send_json(batch), [dumps(request)])
        self.assertEqual(len(result.raw), 2)
        self.assertEqual(result.out, batch)
        for line in result.raw:
            self.assertNotIn("\n", line)

    def test_202_writes_nothing(self):
        result = run_bridge(lambda h, b: h.send_empty(202), [dumps(INITIALIZED)])
        self.assertEqual(result.raw, [])

    def test_non_ascii_survives_the_round_trip(self):
        reply = {"jsonrpc": "2.0", "id": 2, "result": {"text": "Klakix üğş ✨"}}
        result = run_bridge(lambda h, b: h.send_json(reply), [dumps(LIST_TOOLS)])
        self.assertEqual(result.out, [reply])

    def test_empty_ok_body_writes_nothing_and_bad_json_body_errors(self):
        result = run_bridge(lambda h, b: h.send_text("  "), [dumps(LIST_TOOLS)])
        self.assertEqual(result.raw, [])
        result = run_bridge(lambda h, b: h.send_text("<html>", content_type="text/html"), [dumps(LIST_TOOLS)])
        self.assertEqual(result.out[0]["error"]["code"], -32603)
        self.assertIn("not valid JSON", result.out[0]["error"]["message"])


class SseTest(unittest.TestCase):
    def test_reads_jsonrpc_messages_from_sse(self):
        def responder(handler, body):
            handler.send_sse(
                [
                    ": keep-alive\n\n",
                    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
                    'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":2,"result":{"tools":[]}}\r\n\r\n',
                ]
            )

        result = run_bridge(responder, [dumps(LIST_TOOLS)])
        self.assertEqual(
            result.out,
            [
                {"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}},
                {"jsonrpc": "2.0", "id": 2, "result": {"tools": []}},
            ],
        )

    def test_events_split_across_chunks_and_last_event_without_blank_line(self):
        def responder(handler, body):
            handler.send_sse(
                [
                    'data: {"jsonrpc":"2.0","id"',
                    0.05,
                    ':2,"result":{}}\n',
                    0.05,
                    "\n",
                    'data: {"jsonrpc":"2.0","id":3,"result":{}}',
                ]
            )

        result = run_bridge(responder, [dumps(LIST_TOOLS)])
        self.assertEqual([m["id"] for m in result.out], [2, 3])

    def test_sse_initialize_result_sets_protocol_version(self):
        def responder(handler, body):
            if body["method"] == "initialize":
                handler.send_sse(["event: message\ndata: " + dumps(INIT_RESULT) + "\n\n"])
            else:
                ok_for(handler, body)

        result = run_bridge(responder, [dumps(INIT), dumps(LIST_TOOLS)])
        self.assertEqual(result.calls[1]["headers"]["mcp-protocol-version"], "2025-03-26")

    def test_invalid_sse_event_is_ignored(self):
        def responder(handler, body):
            handler.send_sse(["data: not json\n\n", 'data: {"jsonrpc":"2.0","id":2,"result":{}}\n\n'])

        result = run_bridge(responder, [dumps(LIST_TOOLS)])
        self.assertEqual([m["id"] for m in result.out], [2])
        self.assertTrue(any("not valid JSON" in line for line in result.logs))


class ErrorTest(unittest.TestCase):
    def test_401_gives_auth_error_for_requests(self):
        result = run_bridge(lambda h, b: h.send_text("unauthorized", status=401), [dumps(INIT)])
        self.assertEqual(
            result.out, [{"jsonrpc": "2.0", "id": 1, "error": {"code": -32001, "message": AUTH_MESSAGE}}]
        )
        self.assertIn("https://klakix.com/app/mcp", AUTH_MESSAGE)
        self.assertIn("KLAKIX_API_KEY", AUTH_MESSAGE)

    def test_500_with_jsonrpc_error_body_passes_through(self):
        body = {"jsonrpc": "2.0", "id": 2, "error": {"code": -32602, "message": "bad params"}}
        result = run_bridge(lambda h, b: h.send_json(body, status=500), [dumps(LIST_TOOLS)])
        self.assertEqual(result.out, [body])

    def test_400_with_jsonrpc_error_body_passes_through(self):
        body = {"jsonrpc": "2.0", "id": 2, "error": {"code": -32602, "message": "bad params"}}
        result = run_bridge(lambda h, b: h.send_json(body, status=400), [dumps(LIST_TOOLS)])
        self.assertEqual(result.out, [body])

    def test_500_plain_text_gives_internal_error_with_snippet(self):
        result = run_bridge(lambda h, b: h.send_text("Bad   gateway\n oops", status=500), [dumps(LIST_TOOLS)])
        error = result.out[0]["error"]
        self.assertEqual(result.out[0]["id"], 2)
        self.assertEqual(error["code"], -32603)
        self.assertEqual(error["message"], "Klakix MCP server returned HTTP 500: Bad gateway oops")

    def test_500_json_that_is_not_jsonrpc_gives_internal_error(self):
        result = run_bridge(lambda h, b: h.send_json({"oops": True}, status=500), [dumps(LIST_TOOLS)])
        self.assertEqual(result.out[0]["error"]["code"], -32603)
        self.assertIn("HTTP 500", result.out[0]["error"]["message"])

    def test_network_failure_gives_internal_error(self):
        # Port 9 on loopback has no listener.
        result = run_bridge(lambda h, b: None, [dumps(LIST_TOOLS)], url="http://127.0.0.1:9/api/mcp")
        error = result.out[0]["error"]
        self.assertEqual(error["code"], -32603)
        self.assertTrue(error["message"].startswith("Could not reach the Klakix MCP server:"))

    def test_notifications_are_never_answered(self):
        for responder in (
            lambda h, b: h.send_text("no", status=401),
            lambda h, b: h.send_text("boom", status=500),
        ):
            result = run_bridge(responder, [dumps(INITIALIZED)])
            self.assertEqual(result.raw, [])
        result = run_bridge(lambda h, b: None, [dumps(INITIALIZED)], url="http://127.0.0.1:9/api/mcp")
        self.assertEqual(result.raw, [])

    def test_batch_failure_answers_every_request_but_no_notification(self):
        batch = [
            {"jsonrpc": "2.0", "id": 7, "method": "ping"},
            {"jsonrpc": "2.0", "method": "notifications/x"},
            {"jsonrpc": "2.0", "id": "a", "method": "ping"},
        ]
        result = run_bridge(lambda h, b: h.send_text("x", status=401), [dumps(batch)])
        self.assertEqual([m["id"] for m in result.out], [7, "a"])


class InputTest(unittest.TestCase):
    def test_invalid_json_line_gives_parse_error_and_processing_continues(self):
        result = run_bridge(ok_for, ["{not json", dumps(LIST_TOOLS)])
        self.assertEqual(result.out[0]["error"]["code"], -32700)
        self.assertIsNone(result.out[0]["id"])
        self.assertEqual(len(result.calls), 1)
        self.assertEqual(result.out[1]["id"], 2)

    def test_non_object_line_gives_invalid_request(self):
        result = run_bridge(ok_for, ["[1,2]", "42", "[]"])
        self.assertEqual([m["error"]["code"] for m in result.out], [-32600] * 3)
        self.assertEqual(result.calls, [])

    def test_nan_is_not_valid_json(self):
        result = run_bridge(ok_for, ['{"jsonrpc":"2.0","id":NaN,"method":"x"}'])
        self.assertEqual(result.out[0]["error"]["code"], -32700)

    def test_blank_lines_are_skipped(self):
        result = run_bridge(ok_for, ["", "   ", dumps(LIST_TOOLS)])
        self.assertEqual(len(result.out), 1)

    def test_message_split_across_chunks_and_missing_final_newline(self):
        data = dumps(LIST_TOOLS).encode("utf-8")
        result = run_bridge(ok_for, [data[:10], data[10:]])
        self.assertEqual(result.out, [{"jsonrpc": "2.0", "id": 2, "result": {}}])

    def test_multibyte_character_split_across_chunks(self):
        message = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"text": "ü✨"}}
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
        cut = data.index("ü".encode("utf-8")) + 1  # in the middle of the two-byte character
        result = run_bridge(ok_for, [data[:cut], data[cut:]])
        self.assertEqual(result.calls[0]["body"]["params"]["text"], "ü✨")


class TimeoutTest(unittest.TestCase):
    def test_timeout_when_server_does_not_answer(self):
        release = threading.Event()

        def responder(handler, body):
            release.wait(3)

        started = time.monotonic()
        try:
            result = run_bridge(responder, [dumps(LIST_TOOLS)], timeout=0.3)
        finally:
            release.set()
        error = result.out[0]["error"]
        self.assertEqual(error["code"], -32603)
        self.assertIn("timed out", error["message"])
        self.assertLess(time.monotonic() - started, 2.5)

    def test_timeout_covers_a_stream_that_keeps_sending(self):
        def responder(handler, body):
            try:
                handler.send_sse([": ping\n\n", 0.1] * 30)
            except OSError:
                pass

        started = time.monotonic()
        result = run_bridge(responder, [dumps(LIST_TOOLS)], timeout=0.4)
        self.assertEqual(result.out[0]["error"]["code"], -32603)
        self.assertIn("timed out", result.out[0]["error"]["message"])
        self.assertLess(time.monotonic() - started, 2.0)


class RedactionTest(unittest.TestCase):
    def test_api_key_never_reaches_stdout_or_log(self):
        def responder(handler, body):
            if body["method"] == "initialize":
                handler.send_json(INIT_RESULT)
            else:
                handler.send_text(f"bad credentials for Bearer {KEY}", status=500)

        result = run_bridge(responder, [dumps(INIT), dumps(LIST_TOOLS)])
        everything = "\n".join(result.raw + result.logs)
        self.assertNotIn(KEY, everything)
        self.assertIn("[redacted]", everything)
        self.assertEqual(result.out[1]["error"]["code"], -32603)

    def test_api_key_in_connection_error_is_redacted(self):
        result = run_bridge(
            lambda h, b: None, [dumps(LIST_TOOLS)], url=f"http://127.0.0.1:9/{KEY}"
        )
        everything = "\n".join(result.raw + result.logs)
        self.assertNotIn(KEY, everything)


if __name__ == "__main__":
    unittest.main()
