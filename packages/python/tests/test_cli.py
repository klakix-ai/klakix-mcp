import json
import os
import subprocess
import sys
import unittest

import support
from support import FakeServer, INIT, INIT_RESULT, KEY, dumps
import klakix_mcp


def run_cli(args, stdin="", env_extra=None):
    env = dict(os.environ)
    env.pop("KLAKIX_API_KEY", None)
    env.pop("KLAKIX_MCP_URL", None)
    env["PYTHONPATH"] = str(support.SRC)
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(env_extra or {})
    return subprocess.run(
        [sys.executable, "-m", "klakix_mcp", *args],
        input=stdin.encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=30,
    )


class CliTest(unittest.TestCase):
    def test_version(self):
        proc = run_cli(["--version"])
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.decode().strip(), klakix_mcp.__version__)
        self.assertEqual(klakix_mcp.__version__, "0.1.0")

    def test_help(self):
        proc = run_cli(["--help"])
        self.assertEqual(proc.returncode, 0)
        self.assertIn("Usage:", proc.stdout.decode())
        self.assertIn("uvx klakix-mcp", proc.stdout.decode())

    def test_unknown_option_exits_with_2(self):
        proc = run_cli(["--nope"])
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, b"")
        self.assertIn("klakix-mcp: Unknown option: --nope", proc.stderr.decode())
        self.assertIn("Run klakix-mcp --help for usage.", proc.stderr.decode())

    def test_end_to_end_over_stdio(self):
        def responder(handler, body):
            handler.send_json(INIT_RESULT)

        with FakeServer(responder) as server:
            proc = run_cli(
                ["--url", server.url],
                stdin=dumps(INIT) + "\n",
                env_extra={"KLAKIX_API_KEY": KEY},
            )
            calls = list(server.calls)
        self.assertEqual(proc.returncode, 0)
        lines = proc.stdout.decode().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), INIT_RESULT)
        self.assertEqual(proc.stderr, b"")
        self.assertEqual(calls[0]["headers"]["authorization"], f"Bearer {KEY}")
        self.assertEqual(calls[0]["headers"]["user-agent"], f"klakix-mcp/{klakix_mcp.__version__}")

    def test_verbose_logs_to_stderr_without_the_key(self):
        with FakeServer(lambda h, b: h.send_json(INIT_RESULT)) as server:
            proc = run_cli(
                ["--url", server.url, "--verbose", "--api-key", KEY],
                stdin=dumps(INIT) + "\n",
            )
        self.assertIn("[klakix-mcp] POST", proc.stderr.decode())
        self.assertNotIn(KEY, proc.stderr.decode() + proc.stdout.decode())


if __name__ == "__main__":
    unittest.main()
