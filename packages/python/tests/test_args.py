import unittest

import support  # noqa: F401  (puts src on sys.path)
from klakix_mcp.args import DEFAULT_TIMEOUT_SECONDS, DEFAULT_URL, UsageError, help_text, parse_args


class ParseArgsTest(unittest.TestCase):
    def test_defaults(self):
        config = parse_args([], {})
        self.assertEqual(config.url, DEFAULT_URL)
        self.assertEqual(DEFAULT_URL, "https://klakix.com/api/mcp")
        self.assertEqual(config.timeout_seconds, DEFAULT_TIMEOUT_SECONDS)
        self.assertEqual(DEFAULT_TIMEOUT_SECONDS, 600)
        self.assertIsNone(config.api_key)
        self.assertFalse(config.verbose)

    def test_environment(self):
        config = parse_args(
            [], {"KLAKIX_API_KEY": " avy_sk_x ", "KLAKIX_MCP_URL": "http://localhost:3000/api/mcp"}
        )
        self.assertEqual(config.api_key, "avy_sk_x")
        self.assertEqual(config.url, "http://localhost:3000/api/mcp")

    def test_blank_environment_is_ignored(self):
        config = parse_args([], {"KLAKIX_API_KEY": "  ", "KLAKIX_MCP_URL": ""})
        self.assertIsNone(config.api_key)
        self.assertEqual(config.url, DEFAULT_URL)

    def test_flags_override_environment_in_both_styles(self):
        config = parse_args(
            ["--api-key", "flag_key", "--url=https://example.com/mcp", "--timeout", "30", "--verbose"],
            {"KLAKIX_API_KEY": "env_key"},
        )
        self.assertEqual(config.api_key, "flag_key")
        self.assertEqual(config.url, "https://example.com/mcp")
        self.assertEqual(config.timeout_seconds, 30)
        self.assertTrue(config.verbose)

    def test_blank_api_key_flag_keeps_environment_key(self):
        self.assertEqual(parse_args(["--api-key="], {"KLAKIX_API_KEY": "env"}).api_key, "env")

    def test_help_and_version(self):
        self.assertTrue(parse_args(["--help"], {}).help)
        self.assertTrue(parse_args(["-h"], {}).help)
        self.assertTrue(parse_args(["-v"], {}).version)
        self.assertTrue(parse_args(["--version"], {}).version)

    def test_rejects_bad_input(self):
        for argv in (
            ["--nope"],
            ["--timeout", "0"],
            ["--timeout", "-1"],
            ["--timeout", "abc"],
            ["--timeout", "inf"],
            ["--timeout"],
            ["--url", "ftp://x"],
            ["--url", "not a url"],
            ["--url", "http://"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(UsageError):
                    parse_args(argv, {})

    def test_usage_error_messages(self):
        with self.assertRaisesRegex(UsageError, "^Missing value for --timeout$"):
            parse_args(["--timeout"], {})
        with self.assertRaisesRegex(UsageError, "^Unknown option: --nope$"):
            parse_args(["--nope"], {})
        with self.assertRaisesRegex(UsageError, "must start with https:// or http://"):
            parse_args(["--url", "ftp://x"], {})
        with self.assertRaisesRegex(UsageError, "not a valid URL"):
            parse_args(["--url", "not a url"], {})

    def test_help_text_names_every_option_and_has_no_exclamation_marks(self):
        text = help_text("1.2.3")
        self.assertNotIn("!", text)
        self.assertIn("klakix-mcp 1.2.3", text)
        for item in (
            "--api-key",
            "--url",
            "--timeout",
            "--verbose",
            "--help",
            "--version",
            "KLAKIX_API_KEY",
            "KLAKIX_MCP_URL",
            DEFAULT_URL,
        ):
            self.assertIn(item, text)


if __name__ == "__main__":
    unittest.main()
