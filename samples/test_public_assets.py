#!/usr/bin/env python3
"""Packaging guards for the public, synthetic-only sample runner."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import unittest
import datetime as dt
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


sys.dont_write_bytecode = True

SAMPLES = Path(__file__).resolve().parent
ROOT = SAMPLES.parent
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
    "13_slack_ai_exfil.otlp.json",
    "14_devin_secrets_leak.otlp.json",
    "15_bing_greshake.otlp.json",
]
SYNTHETIC_SEQUENCE = [
    "11_delayed_exfil_day0_write.otlp.json",
    "12_delayed_exfil_day2_egress.otlp.json",
]
RUNNER_FIXTURES = sorted(DISCLOSURE_FIXTURES + SYNTHETIC_SEQUENCE)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ASSERTIONS = load_module("assert_verdicts", SAMPLES / "assert-verdicts.py")


class PublicSampleAssetsTest(unittest.TestCase):
    def test_agentdojo_summary_is_internally_consistent(self) -> None:
        summary_path = (
            ROOT
            / "benchmarks"
            / "agentdojo-v0.1.35-gpt4o-important-instructions.summary.json"
        )
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        self.assertEqual(summary["schema_version"], 1)
        replay = summary["replay"]
        self.assertEqual(replay["selected"], 726)
        self.assertEqual(replay["completed"], 726)
        self.assertEqual(replay["scan_errors"], 0)
        self.assertRegex(
            summary["provenex"]["scanner_binary_sha256"], r"^[0-9a-f]{64}$"
        )
        self.assertRegex(
            replay["full_result_artifact_sha256"], r"^[0-9a-f]{64}$"
        )
        self.assertEqual(
            replay["full_result_artifact"],
            "agentdojo-v0.1.35-gpt4o-important-instructions.full.json",
        )
        full_path = summary_path.with_name(replay["full_result_artifact"])
        full_bytes = full_path.read_bytes()
        self.assertEqual(
            hashlib.sha256(full_bytes).hexdigest(),
            replay["full_result_artifact_sha256"],
        )
        full = json.loads(full_bytes)
        self.assertEqual(full["publication"]["canonical_benchmark_eligible"], True)
        self.assertEqual(full["provenex"]["source_commit"], summary["provenex"]["commit"])
        self.assertEqual(
            full["provenex"]["scanner_sha256"],
            summary["provenex"]["scanner_binary_sha256"],
        )

        funnel = summary["scope_funnel"]
        self.assertEqual(funnel["attack_labeled_trajectories"], 629)
        self.assertEqual(funnel["target_achieved_trajectories"], 300)
        self.assertEqual(funnel["target_achieved_tool_action_trajectories"], 297)
        self.assertEqual(
            funnel["target_achieved_protected_action_trajectories"], 279
        )
        self.assertEqual(
            funnel["target_achieved_external_source_read_trajectories"], 18
        )
        self.assertEqual(funnel["target_achieved_text_only_trajectories"], 3)
        self.assertEqual(
            funnel["target_achieved_protected_action_trajectories"]
            + funnel["target_achieved_external_source_read_trajectories"],
            funnel["target_achieved_tool_action_trajectories"],
        )
        self.assertEqual(
            funnel["target_achieved_tool_action_trajectories"]
            + funnel["target_achieved_text_only_trajectories"],
            funnel["target_achieved_trajectories"],
        )

        results = summary["results"]
        protected = results["target_achieved_protected_action_any_target_red"]
        required = results[
            "target_achieved_protected_action_required_coverage_red"
        ]
        self.assertEqual((protected["red"], protected["total"]), (240, 279))
        self.assertEqual((required["red"], required["total"]), (222, 279))
        full_protected = full["summary"][
            "attack_succeeded_protected_action_trajectories"
        ]
        self.assertEqual(
            full_protected["trajectories_with_any_target_receipt_red"],
            protected["red"],
        )
        self.assertEqual(full_protected["planned"], protected["total"])
        misses = summary["protected_action_misses"]
        categorized = sum(
            value
            for key, category in misses.items()
            if key != "total"
            for value in category.values()
        )
        self.assertEqual(categorized, misses["total"])

    def test_honest_mistake_summary_binds_every_published_fixture(self) -> None:
        benchmark = ROOT / "benchmarks" / "honest-mistakes"
        summary = json.loads(
            (benchmark / "summary.json").read_text(encoding="utf-8")
        )
        self.assertEqual(summary["schema_version"], 1)
        self.assertEqual(summary["measurement"], "offline-policy-scoped-matched-pairs")
        self.assertRegex(summary["provenex"]["commit"], r"^[0-9a-f]{40}$")
        self.assertRegex(summary["provenex"]["source_tree"], r"^[0-9a-f]{40}$")
        self.assertEqual(
            summary["results"],
            {
                "unsafe_red": 5,
                "unsafe_total": 5,
                "benign_zero_red": 5,
                "benign_total": 5,
                "test_failures": 0,
            },
        )

        policy = benchmark / "policies.yaml"
        self.assertEqual(
            hashlib.sha256(policy.read_bytes()).hexdigest(),
            summary["policy_sha256"],
        )

        archetypes = summary["archetypes"]
        self.assertEqual(len(archetypes), 5)
        self.assertEqual(len({item["id"] for item in archetypes}), 5)
        expected_bindings = {
            "cross-zone-composition",
            "untrusted-influence-on-privileged-action",
        }
        for item in archetypes:
            with self.subTest(archetype=item["id"]):
                directory = benchmark / item["id"]
                unsafe = directory / "reconstructed_trace.otlp.json"
                benign = directory / "benign_twin_trace.otlp.json"
                trust_zones = directory / "customer_trust_zones.yaml"
                self.assertEqual(
                    hashlib.sha256(unsafe.read_bytes()).hexdigest(),
                    item["unsafe_sha256"],
                )
                self.assertEqual(
                    hashlib.sha256(benign.read_bytes()).hexdigest(),
                    item["benign_sha256"],
                )
                self.assertEqual(
                    hashlib.sha256(trust_zones.read_bytes()).hexdigest(),
                    item["trust_zones_sha256"],
                )
                self.assertIsInstance(json.loads(unsafe.read_text(encoding="utf-8")), dict)
                self.assertIsInstance(json.loads(benign.read_text(encoding="utf-8")), dict)
                self.assertIn(item["unsafe_binding"], expected_bindings)
                self.assertIs(item["unsafe_red"], True)
                self.assertIs(item["benign_red"], False)

    def test_public_docs_have_valid_relative_links_and_no_stale_contracts(self) -> None:
        markdown_files = [
            ROOT / "README.md",
            ROOT / "SECURITY.md",
            SAMPLES / "README.md",
            *sorted((ROOT / "docs").glob("*.md")),
            *sorted((ROOT / "benchmarks").glob("**/*.md")),
        ]
        banned = {
            "Run observe rehearsal",
            "Run block rehearsal",
            "NotEvaluableAdapterMissing",
            "provenex-scan --json",
            "every published breach",
            "strict recall ~0.48",
            "roughly 0.70 recall",
            "Edge browser dispatch is not wired",
            "not accepted directly by the Edge browser import",
        }
        for document in markdown_files:
            body = document.read_text(encoding="utf-8")
            for phrase in banned:
                with self.subTest(document=document.name, phrase=phrase):
                    self.assertNotIn(phrase, body)
            for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", body):
                if target.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                relative = target.split("#", 1)[0]
                if not relative:
                    continue
                with self.subTest(document=document.name, target=target):
                    self.assertTrue(
                        (document.parent / relative).resolve().exists(),
                        f"broken relative link in {document}: {target}",
                    )

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
        self.assertIn("HTTP 403", runner)
        self.assertIn('--config "$AUTH_CONFIG"', runner)
        self.assertNotIn('-H "Authorization: Bearer $KEY"', runner)
        self.assertIn("Engine URL must use HTTPS", runner)
        self.assertIn('--dump-header "$response_headers"', runner)
        self.assertIn("X-Provenex-Source-Commit", runner)
        self.assertIn('"engine_source_commit": source_commit', runner)
        self.assertNotIn("no UEBA can see", runner)
        self.assertNotIn("12 reconstructions of named production", runner)
        self.assertNotIn(
            'PROVENEX_DEMO_ENGINE_URL:-https://provenex-verdict.fly.dev', runner
        )

        expectations = json.loads(
            (SAMPLES / "expectations.json").read_text(encoding="utf-8")
        )
        self.assertEqual(list(expectations["scenarios"]), RUNNER_FIXTURES)

    def test_every_fixture_is_valid_otlp_json(self) -> None:
        for name in RUNNER_FIXTURES:
            with self.subTest(fixture=name):
                data = json.loads((SAMPLES / name).read_text(encoding="utf-8"))
                self.assertIsInstance(data.get("resourceSpans"), list)
                self.assertTrue(data["resourceSpans"])
                for span in ASSERTIONS.iter_spans(data):
                    self.assertRegex(span.get("traceId", ""), r"^[0-9a-f]{32}$")
                    self.assertRegex(span.get("spanId", ""), r"^[0-9a-f]{16}$")
                    parent = span.get("parentSpanId")
                    if parent:
                        self.assertRegex(parent, r"^[0-9a-f]{16}$")
                    for link in span.get("links", []):
                        self.assertRegex(link.get("traceId", ""), r"^[0-9a-f]{32}$")
                        self.assertRegex(link.get("spanId", ""), r"^[0-9a-f]{16}$")

    def test_named_cases_are_labeled_as_reconstructions(self) -> None:
        for name in DISCLOSURE_FIXTURES:
            with self.subTest(fixture=name):
                data = json.loads((SAMPLES / name).read_text(encoding="utf-8"))
                label = data.get("_label", "")
                self.assertIn("constructed-from-public-disclosure", label)
                self.assertIn("NOT captured customer telemetry", label)

    def test_renderer_uses_dynamic_key_guidance_and_bounded_verdict_words(self) -> None:
        module = load_module("render_verdict", SAMPLES / "render-verdict.py")

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

    def test_runner_fails_before_network_without_required_acknowledgments(self) -> None:
        runner = SAMPLES / "try-me.sh"
        environment = os.environ.copy()
        for name in (
            "PROVENEX_DEMO_ENGINE_URL",
            "PROVENEX_DEMO_API_TOKEN",
            "PROVENEX_DEMO_ALLOW_SYNTHETIC_CENTRAL",
        ):
            environment.pop(name, None)

        missing_url = subprocess.run(
            ["bash", str(runner), "--no-report"],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(missing_url.returncode, 1)
        self.assertIn("PROVENEX_DEMO_ENGINE_URL", missing_url.stderr)

        environment.update(
            {
                "PROVENEX_DEMO_ENGINE_URL": "https://engine.invalid",
                "PROVENEX_DEMO_API_TOKEN": "pvx_trial_not-used",
            }
        )
        missing_ack = subprocess.run(
            ["bash", str(runner), "--no-report"],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(missing_ack.returncode, 1)
        self.assertIn("PROVENEX_DEMO_ALLOW_SYNTHETIC_CENTRAL", missing_ack.stderr)

        unknown = subprocess.run(
            ["bash", str(runner), "--not-a-real-option"],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(unknown.returncode, 2)
        self.assertIn("unknown argument", unknown.stderr)

        environment["PROVENEX_DEMO_ALLOW_SYNTHETIC_CENTRAL"] = "1"
        environment["PROVENEX_DEMO_ENGINE_URL"] = "http://engine.invalid/path"
        unsafe_url = subprocess.run(
            ["bash", str(runner), "--no-report"],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(unsafe_url.returncode, 1)
        self.assertIn("Engine URL", unsafe_url.stderr)

    def test_target_expectations_bind_to_unique_fixture_receipts(self) -> None:
        scenarios = ASSERTIONS.load_expectations(SAMPLES / "expectations.json")
        receipt_ids: list[str] = []
        for name, expectation in scenarios.items():
            fixture = ASSERTIONS.load_json(SAMPLES / name)
            for target in expectation.get("targets", []):
                receipt_id, destination = ASSERTIONS.target_identity(fixture, target)
                self.assertTrue(destination)
                receipt_ids.append(receipt_id)
        self.assertEqual(len(receipt_ids), len(set(receipt_ids)))
        self.assertEqual(len(receipt_ids), 17)

        slack = scenarios["13_slack_ai_exfil.otlp.json"]
        slack_fixture = ASSERTIONS.load_json(SAMPLES / "13_slack_ai_exfil.otlp.json")
        self.assertEqual(slack.get("expect_no_red"), True)
        self.assertIsNotNone(ASSERTIONS.known_miss_identity(slack_fixture, slack))

    def test_run_isolation_preserves_payload_shape_and_data_flow(self) -> None:
        namespace = "a1" * 16

        def attributes(document):
            return [
                attribute
                for attribute in ASSERTIONS.iter_attribute_objects(document)
                if isinstance(attribute.get("value", {}).get("stringValue"), str)
            ]

        for fixture_name in RUNNER_FIXTURES:
            with self.subTest(fixture=fixture_name):
                fixture = ASSERTIONS.load_json(SAMPLES / fixture_name)
                isolated = ASSERTIONS.isolate_fixture(fixture, namespace)
                original_attributes = attributes(fixture)
                isolated_attributes = attributes(isolated)
                self.assertEqual(len(original_attributes), len(isolated_attributes))
                uri_map = {
                    original["value"]["stringValue"]: rewritten["value"]["stringValue"]
                    for original, rewritten in zip(
                        original_attributes, isolated_attributes
                    )
                    if original.get("key") in ASSERTIONS.URI_IDENTITY_KEYS
                }
                for original, rewritten in zip(
                    original_attributes, isolated_attributes
                ):
                    self.assertEqual(original.get("key"), rewritten.get("key"))
                    key = original.get("key")
                    original_value = original["value"]["stringValue"]
                    rewritten_value = rewritten["value"]["stringValue"]
                    if key not in ASSERTIONS.PAYLOAD_KEYS:
                        continue
                    self.assertNotEqual(original_value, rewritten_value)
                    try:
                        original_json = json.loads(original_value)
                        rewritten_json = json.loads(rewritten_value)
                    except json.JSONDecodeError:
                        marker = f"\n[pvx-sample-run:{namespace}]"
                        self.assertTrue(rewritten_value.endswith(marker))
                        self.assertEqual(
                            rewritten_value.removesuffix(marker),
                            ASSERTIONS.namespace_string(
                                original_value, namespace, uri_map
                            ),
                        )
                        continue
                    self.assertEqual(
                        rewritten_json,
                        ASSERTIONS.add_run_marker(
                            ASSERTIONS.replace_strings_in_values(
                                original_json, namespace, uri_map
                            ),
                            namespace,
                        ),
                    )
                    if isinstance(original_json, list):
                        self.assertEqual(len(rewritten_json), len(original_json))

        fixture = ASSERTIONS.load_json(SAMPLES / "13_slack_ai_exfil.otlp.json")
        isolated = ASSERTIONS.isolate_fixture(fixture, namespace)
        isolated_attributes = attributes(isolated)
        original_secret = "xoxb-real-secret-key-abc123def456-prodkey-eldritch"
        isolated_secret = ASSERTIONS.namespace_token(original_secret, namespace)
        relevant_values = [
            attribute["value"]["stringValue"]
            for attribute in isolated_attributes
            if attribute.get("key") in ASSERTIONS.PAYLOAD_KEYS | {"url.full"}
        ]
        self.assertFalse(any(original_secret in value for value in relevant_values))
        self.assertGreaterEqual(
            sum(isolated_secret in value for value in relevant_values), 5
        )
        isolated_uris = [
            attribute["value"]["stringValue"]
            for attribute in isolated_attributes
            if attribute.get("key") in ASSERTIONS.URI_IDENTITY_KEYS
        ]
        self.assertTrue(
            all("/pvx-sample-run/" in value for value in isolated_uris)
        )

        spans = {
            span["spanId"]: ASSERTIONS.span_attributes(span)
            for span in ASSERTIONS.iter_spans(isolated)
        }
        output = json.loads(spans["7000000000000001"]["gen_ai.output.messages"])
        output_url = re.search(r"\((https://[^)]+)\)", output[0]["content"]).group(1)
        rendered = json.loads(
            spans["8000000000000001"]["gen_ai.output.messages"]
        )
        rendered_url = re.search(
            r"\((https://[^)]+)\)", rendered[0]["content"]
        ).group(1)
        destination_url = spans["9000000000000001"]["url.full"]
        self.assertEqual(output_url, rendered_url)
        self.assertEqual(rendered_url, destination_url)
        self.assertEqual(
            parse_qs(urlsplit(destination_url).query)["secret"],
            [isolated_secret],
        )
        self.assertEqual(
            spans["9000000000000001"]["server.address"],
            urlsplit(destination_url).hostname,
        )
        self.assertEqual(output[0]["role"], "assistant")
        self.assertEqual(rendered[0]["role"], "assistant")

        # The engine's raw-string payload tokenizer used to treat this JSON
        # schema key as a prefix-style customer id, linking every Comet replay
        # to historical runs. The escaped spelling parses to the identical key
        # but cannot become a raw payload token.
        comet = ASSERTIONS.isolate_fixture(
            ASSERTIONS.load_json(SAMPLES / "09_cometjacking_perplexity.otlp.json"),
            namespace,
        )
        comet_spans = {
            span["spanId"]: ASSERTIONS.span_attributes(span)
            for span in ASSERTIONS.iter_spans(comet)
        }
        comet_arguments = comet_spans["8000000000000901"][
            "gen_ai.tool.call.arguments"
        ]
        self.assertIn('"body\\u005fbase64"', comet_arguments)
        self.assertNotIn('"body_base64"', comet_arguments)
        self.assertIn("body_base64", json.loads(comet_arguments))

        # Provider/model names are semantic policy inputs, not run identity.
        original_comet = ASSERTIONS.load_json(
            SAMPLES / "09_cometjacking_perplexity.otlp.json"
        )
        original_model_values = [
            attribute["value"]["stringValue"]
            for attribute in ASSERTIONS.iter_attribute_objects(original_comet)
            if attribute.get("key")
            in {"gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model"}
        ]
        isolated_model_values = [
            attribute["value"]["stringValue"]
            for attribute in ASSERTIONS.iter_attribute_objects(comet)
            if attribute.get("key")
            in {"gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model"}
        ]
        self.assertEqual(isolated_model_values, original_model_values)

    def test_base64_isolation_is_strict_and_identifier_scoped(self) -> None:
        namespace = "c3" * 16
        email = "alice.long.identifier@example.company"
        encoded_email = __import__("base64").b64encode(email.encode()).decode()
        transformed = ASSERTIONS.namespace_base64_runs(encoded_email, namespace)
        self.assertNotEqual(transformed, encoded_email)

        encoded_prose = __import__("base64").b64encode(
            b"ordinary prose without a linker identifier"
        ).decode()
        self.assertEqual(
            ASSERTIONS.namespace_base64_runs(encoded_prose, namespace),
            encoded_prose,
        )
        invalid = "A" * 33
        self.assertEqual(ASSERTIONS.namespace_base64_runs(invalid, namespace), invalid)

    def test_custom_scheme_roles_and_delayed_join_survive_isolation(self) -> None:
        day0, day2 = ASSERTIONS.isolate_delayed_pair(
            ASSERTIONS.load_json(SAMPLES / SYNTHETIC_SEQUENCE[0]),
            ASSERTIONS.load_json(SAMPLES / SYNTHETIC_SEQUENCE[1]),
            "b2" * 16,
        )

        def uri_values(document):
            return [
                attribute["value"]["stringValue"]
                for attribute in ASSERTIONS.iter_attribute_objects(document)
                if attribute.get("key") in ASSERTIONS.URI_IDENTITY_KEYS
            ]

        day0_uris = uri_values(day0)
        day2_uris = uri_values(day2)
        inbox = next(value for value in day0_uris if value.startswith("outlook://inbox/"))
        send = next(value for value in day2_uris if value.startswith("outlook://send/"))
        self.assertEqual(urlsplit(inbox).netloc, "inbox")
        self.assertTrue(urlsplit(inbox).path.startswith("/external-senders/"))
        self.assertEqual(urlsplit(send).netloc, "send")
        self.assertTrue(urlsplit(send).path.startswith("/external/"))
        shared_day0 = next(value for value in day0_uris if "agent_notes" in value)
        shared_day2 = next(value for value in day2_uris if "agent_notes" in value)
        self.assertEqual(shared_day0, shared_day2)

    def test_incidental_red_and_policy_drift_fail_target_assertion(self) -> None:
        name = DISCLOSURE_FIXTURES[0]
        scenarios = ASSERTIONS.load_expectations(SAMPLES / "expectations.json")
        expectation = scenarios[name]
        fixture = ASSERTIONS.load_json(SAMPLES / name)
        target_id, _ = ASSERTIONS.target_identity(fixture, expectation["targets"][0])
        response = {
            "accepted": True,
            "tenant_id": "tenant-test",
            "persistence_warnings": 0,
            "receipts_ingested": 3,
            "red_verdicts": 1,
            "verdicts": [
                {
                    "correlation_key": target_id,
                    "binding_reason": "cross-zone-composition",
                    "risk": "high",
                }
            ],
            "findings": [{}],
            "ingest_outcome": {
                "status": "evaluable",
                "receipts_ingested": 3,
                "egress_points_seen": 1,
                "not_evaluable_reasons": [],
            },
        }
        message = ASSERTIONS.assert_response(
            fixture_name=name,
            fixture=fixture,
            response=response,
            expectation=expectation,
            tenant_id="tenant-test",
        )
        self.assertIn("exact target receipt", message)

        incidental = json.loads(json.dumps(response))
        incidental["verdicts"][0]["correlation_key"] = "0" * 32 + ":" + "1" * 16
        with self.assertRaises(ASSERTIONS.AssertionFailure):
            ASSERTIONS.assert_response(
                fixture_name=name,
                fixture=fixture,
                response=incidental,
                expectation=expectation,
                tenant_id="tenant-test",
            )

        drifted = json.loads(json.dumps(response))
        drifted["verdicts"][0]["binding_reason"] = "composition-light"
        with self.assertRaises(ASSERTIONS.AssertionFailure):
            ASSERTIONS.assert_response(
                fixture_name=name,
                fixture=fixture,
                response=drifted,
                expectation=expectation,
                tenant_id="tenant-test",
            )

    def test_slack_human_click_is_preserved_as_a_known_miss(self) -> None:
        name = "13_slack_ai_exfil.otlp.json"
        scenarios = ASSERTIONS.load_expectations(SAMPLES / "expectations.json")
        expectation = scenarios[name]
        fixture = ASSERTIONS.load_json(SAMPLES / name)
        miss = ASSERTIONS.known_miss_identity(fixture, expectation)
        self.assertIsNotNone(miss)
        receipt_id, _ = miss
        response = {
            "accepted": True,
            "tenant_id": "tenant-test",
            "persistence_warnings": 0,
            "receipts_ingested": 7,
            "red_verdicts": 0,
            "verdicts": [],
            "findings": [],
            "ingest_outcome": {
                "status": "partial_evaluable",
                "receipts_ingested": 7,
                "egress_points_seen": 0,
                "not_evaluable_reasons": ["no_egress_points"],
            },
        }
        message = ASSERTIONS.assert_response(
            fixture_name=name,
            fixture=fixture,
            response=response,
            expectation=expectation,
            tenant_id="tenant-test",
        )
        self.assertIn("known-miss assertion", message)

        unexpected_catch = json.loads(json.dumps(response))
        unexpected_catch["red_verdicts"] = 1
        unexpected_catch["verdicts"] = [{"correlation_key": receipt_id}]
        unexpected_catch["findings"] = [{}]
        with self.assertRaises(ASSERTIONS.AssertionFailure):
            ASSERTIONS.assert_response(
                fixture_name=name,
                fixture=fixture,
                response=unexpected_catch,
                expectation=expectation,
                tenant_id="tenant-test",
            )

    def test_delayed_pair_is_per_run_and_audit_requires_day0_receipt(self) -> None:
        scenarios = ASSERTIONS.load_expectations(SAMPLES / "expectations.json")
        original_day0 = ASSERTIONS.load_json(SAMPLES / SYNTHETIC_SEQUENCE[0])
        original_day2 = ASSERTIONS.load_json(SAMPLES / SYNTHETIC_SEQUENCE[1])
        isolated_day0, isolated_day2 = ASSERTIONS.isolate_delayed_pair(
            original_day0, original_day2, "a1" * 16
        )
        day2_expectation = scenarios[SYNTHETIC_SEQUENCE[1]]
        target_id, destination = ASSERTIONS.target_identity(
            isolated_day2, day2_expectation["targets"][0]
        )
        required = day2_expectation["required_closure"]
        day0_id, _ = ASSERTIONS.target_identity(
            isolated_day0,
            {
                "span_id": required["span_id"],
                "destination_attribute": "gen_ai.data_source.id",
            },
        )
        original_target, _ = ASSERTIONS.target_identity(
            original_day2, day2_expectation["targets"][0]
        )
        self.assertNotEqual(target_id, original_target)

        recorded = dt.datetime.now(dt.timezone.utc)
        row = {
            "recorded_at": recorded.isoformat().replace("+00:00", "Z"),
            "key_id": "key-test",
            "artifact": {
                "output_receipt_id": target_id,
                "verdict": "red",
                "risk": "high",
                "binding_reason": "high-risk-resource-egress",
                "destination": destination,
                "coverage": {"closure_complete": True},
                "closure_receipt_ids": [target_id, day0_id],
                "class_boundaries": ["time", "persistence"],
                "provenance": {"schema_version": 2, "signer_key_id": "key-test"},
            },
        }
        fixture_paths = {
            SYNTHETIC_SEQUENCE[0]: SAMPLES / SYNTHETIC_SEQUENCE[0],
            SYNTHETIC_SEQUENCE[1]: SAMPLES / SYNTHETIC_SEQUENCE[1],
        }

        # Write no files: patch the strict loader only for the two isolated docs.
        original_loader = ASSERTIONS.load_json
        try:
            ASSERTIONS.load_json = lambda path: (
                isolated_day0
                if Path(path).name == SYNTHETIC_SEQUENCE[0]
                else isolated_day2
                if Path(path).name == SYNTHETIC_SEQUENCE[1]
                else original_loader(path)
            )
            message = ASSERTIONS.assert_audit_run(
                audit={"tenant_id": "tenant-test", "verdicts": [row]},
                scenarios={SYNTHETIC_SEQUENCE[1]: day2_expectation},
                fixture_paths=fixture_paths,
                tenant_id="tenant-test",
                key_id="key-test",
                run_start=(recorded - dt.timedelta(seconds=1))
                .isoformat()
                .replace("+00:00", "Z"),
            )
            self.assertIn("audit assertion: PASS", message)

            invented = f"{target_id.split(':', 1)[0]}:{'f' * 16}"
            row["artifact"]["closure_receipt_ids"] = [
                target_id,
                day0_id,
                invented,
            ]
            with self.assertRaises(ASSERTIONS.AssertionFailure):
                ASSERTIONS.assert_audit_run(
                    audit={"tenant_id": "tenant-test", "verdicts": [row]},
                    scenarios={SYNTHETIC_SEQUENCE[1]: day2_expectation},
                    fixture_paths=fixture_paths,
                    tenant_id="tenant-test",
                    key_id="key-test",
                    run_start=(recorded - dt.timedelta(seconds=1))
                    .isoformat()
                    .replace("+00:00", "Z"),
                )

            row["artifact"]["closure_receipt_ids"] = [target_id]
            with self.assertRaises(ASSERTIONS.AssertionFailure):
                ASSERTIONS.assert_audit_run(
                    audit={"tenant_id": "tenant-test", "verdicts": [row]},
                    scenarios={SYNTHETIC_SEQUENCE[1]: day2_expectation},
                    fixture_paths=fixture_paths,
                    tenant_id="tenant-test",
                    key_id="key-test",
                    run_start=(recorded - dt.timedelta(seconds=1))
                    .isoformat()
                    .replace("+00:00", "Z"),
                )
        finally:
            ASSERTIONS.load_json = original_loader


if __name__ == "__main__":
    unittest.main()
