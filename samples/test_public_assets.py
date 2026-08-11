#!/usr/bin/env python3
"""Packaging guards for the public, synthetic-only sample runner."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path


sys.dont_write_bytecode = True

SAMPLES = Path(__file__).resolve().parent
DISCLOSURE_FIXTURES = [
    "01_echoleak_breach.otlp.json",
    "02_cursor_nomshub.otlp.json",
    "03_curxecute_cursor_mcp.otlp.json",
    "04_agentflayer_chatgpt_connectors.otlp.json",
    "05_forcedleak_salesforce_agentforce.otlp.json",
    "06_shadowleak_chatgpt_deep_research.otlp.json",
    "07_notion3_pdf_exfil.otlp.json",
    "08_camoleak_github_copilot.otlp.json",
    "09_cometjacking_perplexity.otlp.json",
    "10_anthropic_mcp_git_rce.otlp.json",
]
SYNTHETIC_SEQUENCE = [
    "11_delayed_exfil_day0_write.otlp.json",
    "12_delayed_exfil_day2_egress.otlp.json",
]
RUNNER_FIXTURES = DISCLOSURE_FIXTURES + SYNTHETIC_SEQUENCE


class PublicSampleAssetsTest(unittest.TestCase):
    def test_runner_and_directory_have_the_same_fixed_fixture_set(self) -> None:
        on_disk = sorted(path.name for path in SAMPLES.glob("*.otlp.json"))
        self.assertEqual(on_disk, RUNNER_FIXTURES)

        runner = (SAMPLES / "try-me.sh").read_text(encoding="utf-8")
        referenced = re.findall(
            r'^post "([^"]+\.otlp\.json)"', runner, flags=re.MULTILINE
        )
        self.assertEqual(referenced, RUNNER_FIXTURES)
        self.assertIn("PROVENEX_DEMO_ALLOW_SYNTHETIC_CENTRAL", runner)
        self.assertNotIn("PROVENEX_API_KEY", runner)

    def test_every_fixture_is_valid_otlp_json(self) -> None:
        for name in RUNNER_FIXTURES:
            with self.subTest(fixture=name):
                data = json.loads((SAMPLES / name).read_text(encoding="utf-8"))
                self.assertIsInstance(data.get("resourceSpans"), list)
                self.assertTrue(data["resourceSpans"])

    def test_named_cases_are_labeled_as_reconstructions(self) -> None:
        for name in DISCLOSURE_FIXTURES:
            with self.subTest(fixture=name):
                data = json.loads((SAMPLES / name).read_text(encoding="utf-8"))
                label = data.get("_label", "")
                self.assertIn("constructed-from-public-disclosure", label)
                self.assertIn("NOT captured customer telemetry", label)

    def test_renderer_uses_dynamic_key_guidance_and_bounded_verdict_words(self) -> None:
        renderer_path = SAMPLES / "render-verdict.py"
        spec = importlib.util.spec_from_file_location("render_verdict", renderer_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        rendered = module.render(
            "synthetic.otlp.json",
            {
                "tenant_id": "example-tenant",
                "red_verdicts": 0,
                "verdicts": [],
                "findings": [],
            },
        )
        self.assertIn("NO RED", rendered)
        self.assertIn("/v1/health/key", rendered)
        self.assertIn("not proof of complete telemetry coverage", rendered)
        self.assertNotIn("trial-2026-06", rendered)


if __name__ == "__main__":
    unittest.main()
