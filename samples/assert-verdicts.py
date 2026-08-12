#!/usr/bin/env python3
"""Fail-closed assertions for the public synthetic sample runner."""

from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


TRACE_ID_RE = re.compile(r"[0-9a-f]{32}")
SPAN_ID_RE = re.compile(r"[0-9a-f]{16}")
ALLOWED_EVALUABLE_STATUSES = {
    "evaluable",
    "evaluable_with_warnings",
    "partial_evaluable",
}
DAY0_NAME = "11_delayed_exfil_day0_write.otlp.json"
DAY2_NAME = "12_delayed_exfil_day2_egress.otlp.json"
URI_IDENTITY_KEYS = {"gen_ai.data_source.id", "provenex.document.id", "url.full"}
HOST_IDENTITY_KEYS = {"host.name", "server.address"}
PAYLOAD_KEYS = {
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "http.request.body",
    "http.request.body.content",
    "http.response.body",
    "http.response.body.content",
}
IDENTITY_KEYS = {
    "enduser.id",
    "user.id",
    "gen_ai.user.id",
    "gen_ai.agent.id",
    "gen_ai.agent.name",
    "gen_ai.conversation.id",
    "gen_ai.tool.call.id",
    "session.id",
    "service.name",
    "service.namespace",
}
TOKEN_RE = re.compile(r"[A-Za-z0-9@._+-]+")
B64_RUN_RE = re.compile(r"(?<![A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{32,}={0,2})")
UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
SSN_RE = re.compile(r"[0-9]{3}-[0-9]{2}-[0-9]{4}")
RUN_MARKER_KEY = "_provenex_sample_run"


class AssertionFailure(ValueError):
    """The scorer response did not meet the published sample contract."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AssertionFailure(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda value: (_ for _ in ()).throw(
                AssertionFailure(f"non-finite JSON number: {value}")
            ),
        )
    except (OSError, json.JSONDecodeError, AssertionFailure) as exc:
        raise AssertionFailure(f"cannot read strict JSON from {path}: {exc}") from exc


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def iter_spans(document: dict[str, Any]):
    resource_spans = document.get("resourceSpans")
    if not isinstance(resource_spans, list):
        raise AssertionFailure("fixture resourceSpans must be a list")
    for resource in resource_spans:
        for scope in resource.get("scopeSpans", []):
            for span in scope.get("spans", []):
                if not isinstance(span, dict):
                    raise AssertionFailure("fixture span must be an object")
                yield span


def span_attributes(span: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for attribute in span.get("attributes", []):
        key = attribute.get("key")
        value = attribute.get("value")
        if not isinstance(key, str) or not key or not isinstance(value, dict):
            raise AssertionFailure("fixture contains a malformed span attribute")
        if key in result:
            raise AssertionFailure(f"fixture span contains duplicate attribute {key}")
        if set(value) != {"stringValue"} or not isinstance(value["stringValue"], str):
            continue
        result[key] = value["stringValue"]
    return result


def target_identity(
    fixture: dict[str, Any], target: dict[str, Any]
) -> tuple[str, str]:
    span_id = target.get("span_id")
    destination_attribute = target.get("destination_attribute")
    if not isinstance(span_id, str) or not SPAN_ID_RE.fullmatch(span_id):
        raise AssertionFailure(f"invalid target span_id: {span_id!r}")
    if not isinstance(destination_attribute, str) or not destination_attribute:
        raise AssertionFailure("target destination_attribute must be a non-empty string")

    matches = [
        span
        for span in iter_spans(fixture)
        if str(span.get("spanId", "")).lower() == span_id
    ]
    if len(matches) != 1:
        raise AssertionFailure(
            f"target span {span_id} occurs {len(matches)} times; expected exactly one"
        )
    span = matches[0]
    trace_id = str(span.get("traceId", "")).lower()
    if not TRACE_ID_RE.fullmatch(trace_id):
        raise AssertionFailure(f"target span {span_id} has invalid traceId {trace_id!r}")
    destination = span_attributes(span).get(destination_attribute)
    if not destination:
        raise AssertionFailure(
            f"target span {span_id} lacks {destination_attribute} destination"
        )
    return f"{trace_id}:{span_id}", destination


def known_miss_identity(
    fixture: dict[str, Any], expectation: dict[str, Any]
) -> tuple[str, str] | None:
    known_miss = expectation.get("known_miss")
    if known_miss is None:
        return None
    if not isinstance(known_miss, dict):
        raise AssertionFailure("known_miss must be an object")
    reason = known_miss.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise AssertionFailure("known_miss reason must be a non-empty string")
    return target_identity(fixture, known_miss)


def load_expectations(path: Path) -> dict[str, Any]:
    document = load_json(path)
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise AssertionFailure("expectations must use schema_version 1")
    scenarios = document.get("scenarios")
    if not isinstance(scenarios, dict) or not scenarios:
        raise AssertionFailure("expectations.scenarios must be a non-empty object")
    return scenarios


def assert_response(
    *,
    fixture_name: str,
    fixture: dict[str, Any],
    response: dict[str, Any],
    expectation: dict[str, Any],
    tenant_id: str,
) -> str:
    if response.get("accepted") is not True:
        raise AssertionFailure(
            f"{fixture_name}: Engine did not accept the fixture as evaluable"
        )
    if response.get("tenant_id") != tenant_id:
        raise AssertionFailure(
            f"{fixture_name}: response tenant does not match authenticated key"
        )
    if response.get("persistence_warnings") != 0:
        raise AssertionFailure(
            f"{fixture_name}: persistence_warnings must be zero for run evidence"
        )

    outcome = response.get("ingest_outcome")
    if not isinstance(outcome, dict):
        raise AssertionFailure(f"{fixture_name}: ingest_outcome is missing")
    status = outcome.get("status")
    if status not in ALLOWED_EVALUABLE_STATUSES:
        raise AssertionFailure(f"{fixture_name}: non-evaluable status {status!r}")

    receipts = response.get("receipts_ingested")
    if not isinstance(receipts, int) or isinstance(receipts, bool) or receipts <= 0:
        raise AssertionFailure(f"{fixture_name}: receipts_ingested must be positive")
    if outcome.get("receipts_ingested") != receipts:
        raise AssertionFailure(
            f"{fixture_name}: top-level and ingest_outcome receipt counts differ"
        )

    red_count = response.get("red_verdicts")
    verdicts = response.get("verdicts")
    findings = response.get("findings")
    if (
        not isinstance(red_count, int)
        or isinstance(red_count, bool)
        or not isinstance(verdicts, list)
        or not isinstance(findings, list)
        or red_count != len(verdicts)
        or red_count != len(findings)
    ):
        raise AssertionFailure(
            f"{fixture_name}: Red count, verdicts, and findings are inconsistent"
        )

    if expectation.get("expect_no_red") is True:
        expected_egress = expectation.get("expect_egress_points_seen")
        reasons = outcome.get("not_evaluable_reasons")
        if red_count != 0:
            raise AssertionFailure(f"{fixture_name}: expected zero Red verdicts")
        if outcome.get("egress_points_seen") != expected_egress:
            raise AssertionFailure(
                f"{fixture_name}: expected {expected_egress} egress points"
            )
        if status != "partial_evaluable" or not isinstance(reasons, list):
            raise AssertionFailure(
                f"{fixture_name}: no-egress control must be partial_evaluable"
            )
        if "no_egress_points" not in reasons:
            raise AssertionFailure(
                f"{fixture_name}: no-egress control omitted no_egress_points reason"
            )
        miss = known_miss_identity(fixture, expectation)
        if miss is not None:
            receipt_id, _ = miss
            if any(
                isinstance(verdict, dict)
                and verdict.get("correlation_key") == receipt_id
                for verdict in verdicts
            ):
                raise AssertionFailure(
                    f"{fixture_name}: declared known miss {receipt_id} unexpectedly "
                    "became Red; refresh the published coverage"
                )
            return "known-miss assertion: PASS (declared receipt unassessed; 0 Red)"
        return (
            f"target assertion: PASS (0 Red; "
            f"{outcome.get('egress_points_seen')} egress points)"
        )

    targets = expectation.get("targets")
    if not isinstance(targets, list) or not targets:
        raise AssertionFailure(f"{fixture_name}: positive scenario has no targets")
    for target in targets:
        receipt_id, _ = target_identity(fixture, target)
        matches = [
            verdict
            for verdict in verdicts
            if isinstance(verdict, dict)
            and verdict.get("correlation_key") == receipt_id
        ]
        if len(matches) != 1:
            raise AssertionFailure(
                f"{fixture_name}: target receipt {receipt_id} has {len(matches)} "
                "Red verdicts; incidental Reds do not satisfy this scenario"
            )
        verdict = matches[0]
        if verdict.get("binding_reason") != target.get("binding_reason"):
            raise AssertionFailure(
                f"{fixture_name}: target {receipt_id} binding drifted: "
                f"expected {target.get('binding_reason')!r}, got "
                f"{verdict.get('binding_reason')!r}"
            )
        if verdict.get("risk") != target.get("risk"):
            raise AssertionFailure(
                f"{fixture_name}: target {receipt_id} risk drifted: "
                f"expected {target.get('risk')!r}, got {verdict.get('risk')!r}"
            )
    return f"target assertion: PASS ({len(targets)} exact target receipt(s) Red)"


def parse_timestamp(value: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise AssertionFailure(f"invalid RFC3339 timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise AssertionFailure(f"timestamp lacks timezone: {value!r}")
    return parsed.astimezone(dt.timezone.utc)


def assert_audit_run(
    *,
    audit: dict[str, Any],
    scenarios: dict[str, Any],
    fixture_paths: dict[str, Path],
    tenant_id: str,
    key_id: str,
    run_start: str,
) -> str:
    if audit.get("tenant_id") != tenant_id:
        raise AssertionFailure("audit tenant does not match authenticated key")
    rows = audit.get("verdicts")
    if not isinstance(rows, list):
        raise AssertionFailure("audit verdicts must be a list")
    start = parse_timestamp(run_start)
    recent_rows = [
        row
        for row in rows
        if isinstance(row, dict)
        and parse_timestamp(row.get("recorded_at", "")) >= start
    ]

    asserted = 0
    for fixture_name, expectation in scenarios.items():
        targets = expectation.get("targets", [])
        if not targets:
            continue
        fixture = load_json(fixture_paths[fixture_name])
        allowed_receipt_ids = {
            f"{str(span.get('traceId', '')).lower()}:"
            f"{str(span.get('spanId', '')).lower()}"
            for span in iter_spans(fixture)
        }
        required = expectation.get("required_closure")
        if isinstance(required, dict):
            source_name = required.get("fixture")
            source_fixture = load_json(fixture_paths[source_name])
            allowed_receipt_ids.update(
                f"{str(span.get('traceId', '')).lower()}:"
                f"{str(span.get('spanId', '')).lower()}"
                for span in iter_spans(source_fixture)
            )
        for target in targets:
            receipt_id, destination = target_identity(fixture, target)
            matches = [
                row
                for row in recent_rows
                if isinstance(row.get("artifact"), dict)
                and row["artifact"].get("output_receipt_id") == receipt_id
            ]
            if len(matches) != 1:
                raise AssertionFailure(
                    f"{fixture_name}: audit has {len(matches)} current-run rows for "
                    f"target {receipt_id}; expected exactly one"
                )
            row = matches[0]
            artifact = row["artifact"]
            expected = {
                "verdict": "red",
                "risk": target.get("risk"),
                "binding_reason": target.get("binding_reason"),
                "destination": target.get("expected_destination", destination),
            }
            for field, value in expected.items():
                if artifact.get(field) != value:
                    raise AssertionFailure(
                        f"{fixture_name}: audit target {receipt_id} {field} drifted: "
                        f"expected {value!r}, got {artifact.get(field)!r}"
                    )
            if row.get("key_id") != key_id:
                raise AssertionFailure(
                    f"{fixture_name}: audit row key id does not match key health"
                )
            coverage = artifact.get("coverage")
            if not isinstance(coverage, dict) or coverage.get("closure_complete") is not True:
                raise AssertionFailure(
                    f"{fixture_name}: target closure is not reported complete"
                )
            provenance = artifact.get("provenance")
            if (
                not isinstance(provenance, dict)
                or provenance.get("schema_version") != 2
                or provenance.get("signer_key_id") != key_id
            ):
                raise AssertionFailure(
                    f"{fixture_name}: target lacks schema-v2 signer provenance"
                )
            closure_ids = artifact.get("closure_receipt_ids")
            if not isinstance(closure_ids, list) or not closure_ids:
                raise AssertionFailure(
                    f"{fixture_name}: target artifact lacks closure receipt ids"
                )
            if any(
                not isinstance(closure_id, str)
                or not re.fullmatch(
                    r"[0-9a-f]{32}:[0-9a-f]{16}", closure_id
                )
                for closure_id in closure_ids
            ):
                raise AssertionFailure(
                    f"{fixture_name}: target closure contains a malformed receipt id"
                )
            closure_receipts = set(closure_ids)
            if len(closure_receipts) != len(closure_ids):
                raise AssertionFailure(
                    f"{fixture_name}: target closure contains duplicate receipt ids"
                )
            if receipt_id not in closure_receipts:
                raise AssertionFailure(
                    f"{fixture_name}: target closure omits its output receipt"
                )
            if not closure_receipts.issubset(allowed_receipt_ids):
                unexpected = sorted(closure_receipts - allowed_receipt_ids)
                raise AssertionFailure(
                    f"{fixture_name}: target closure is contaminated by receipts "
                    f"outside this isolated scenario: {unexpected}"
                )
            asserted += 1

        if isinstance(required, dict):
            source_fixture = load_json(fixture_paths[source_name])
            source_receipt, _ = target_identity(
                source_fixture,
                {
                    "span_id": required.get("span_id"),
                    "destination_attribute": "gen_ai.data_source.id",
                },
            )
            target_receipt, _ = target_identity(fixture, targets[0])
            row = next(
                row
                for row in recent_rows
                if row.get("artifact", {}).get("output_receipt_id") == target_receipt
            )
            artifact = row["artifact"]
            if source_receipt not in artifact.get("closure_receipt_ids", []):
                raise AssertionFailure(
                    f"{fixture_name}: target closure omits this run's Day 0 receipt"
                )
            boundary = required.get("class_boundary")
            if boundary not in artifact.get("class_boundaries", []):
                raise AssertionFailure(
                    f"{fixture_name}: target artifact omits {boundary!r} boundary"
                )

    return f"audit assertion: PASS ({asserted} target artifact(s), current run only)"


def replace_strings(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        for old, new in replacements.items():
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [replace_strings(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: replace_strings(item, replacements) for key, item in value.items()}
    return value


def is_prefix_id(token: str) -> bool:
    if not 6 <= len(token) <= 64:
        return False
    positions = [position for position in (token.find("-"), token.find("_")) if position >= 0]
    if not positions:
        return False
    separator = min(positions)
    prefix, tail = token[:separator], token[separator + 1 :]
    return (
        2 <= len(prefix) <= 8
        and prefix.isalpha()
        and len(tail) >= 4
        and tail[0].isalnum()
        and tail[-1].isalnum()
        and all(character.isalnum() or character in "-_" for character in tail)
        and any(character.isdigit() for character in tail)
    )


def is_email(token: str) -> bool:
    if token.count("@") != 1:
        return False
    local, domain = token.split("@")
    return bool(local and "." in domain and domain.strip(".") == domain)


def namespace_token(token: str, namespace: str) -> str:
    digest = hashlib.sha256(f"{namespace}:{token}".encode()).hexdigest()
    if UUID_RE.fullmatch(token):
        return f"{digest[:8]}-{digest[8:12]}-{digest[12:16]}-{digest[16:20]}-{digest[20:32]}"
    if SSN_RE.fullmatch(token):
        digits = str(int(digest[:12], 16)).zfill(12)[-9:]
        return f"{digits[:3]}-{digits[3:5]}-{digits[5:]}"
    if is_email(token):
        local, domain = token.split("@")
        suffix = f"+pvx{digest[:8]}"
        return f"{local[: max(1, 64 - len(suffix))]}{suffix}@{domain}"
    if is_prefix_id(token):
        separator = min(
            position for position in (token.find("-"), token.find("_")) if position >= 0
        )
        return f"{token[:separator]}-{digest[:9]}0"
    return token


def namespace_tokens(value: str, namespace: str) -> str:
    return TOKEN_RE.sub(lambda match: namespace_token(match.group(0), namespace), value)


def namespace_base64_runs(value: str, namespace: str) -> str:
    marker = f"[pvx-sample-run:{namespace}]"

    def transform(match: re.Match[str]) -> str:
        encoded = match.group(1)
        padded = encoded + "=" * (-len(encoded) % 4)
        decoded: str | None = None
        for altchars in (None, b"-_"):
            try:
                decoded_bytes = base64.b64decode(
                    padded, altchars=altchars, validate=True
                )
                candidate = decoded_bytes.decode("utf-8")
            except (ValueError, base64.binascii.Error):
                continue
            if not candidate:
                continue
            printable = sum(
                character.isprintable() or character in "\r\n\t"
                for character in candidate
            )
            if printable * 10 < len(candidate) * 9:
                continue
            decoded = candidate
            break
        if decoded is None:
            return encoded
        if marker in decoded:
            return encoded
        transformed_payload = namespace_tokens(decoded, namespace)
        # Leave ordinary encoded prose/bytes alone. Only identifiers that can
        # actually rejoin receipts need per-run isolation.
        if transformed_payload == decoded:
            return encoded
        transformed = f"{transformed_payload} {marker}"
        return base64.b64encode(transformed.encode()).decode()

    return B64_RUN_RE.sub(transform, value)


def namespace_uri(value: str, namespace: str) -> str:
    try:
        split = urlsplit(value)
    except ValueError:
        return f"{namespace_tokens(value, namespace)}-pvx-{namespace}"
    if not split.scheme:
        return f"{namespace_tokens(value, namespace)}-pvx-{namespace}"
    # Append after the evaluator-relevant URI shape. Prefixes such as
    # outlook://send/external/, slack://channels/public/, and file:///etc/
    # carry trust semantics; inserting before them would change the scenario.
    base_path = namespace_tokens(split.path, namespace).rstrip("/")
    path = f"{base_path}/pvx-sample-run/{namespace}"
    if not path.startswith("/"):
        path = f"/{path}"
    netloc = split.netloc
    if split.scheme in {"http", "https"} and split.hostname:
        host = namespace_host(split.hostname, namespace)
        netloc = f"[{host}]" if ":" in host else host
        if split.port is not None:
            netloc = f"{netloc}:{split.port}"
    query_pairs = [
        (
            namespace_tokens(key, namespace),
            namespace_base64_runs(namespace_tokens(item, namespace), namespace),
        )
        for key, item in parse_qsl(split.query, keep_blank_values=True)
    ]
    query_pairs.append(("pvx_sample_run", namespace))
    return urlunsplit(
        (split.scheme, netloc, path, urlencode(query_pairs), split.fragment)
    )


def namespace_host(value: str, namespace: str) -> str:
    if value in {"localhost", "127.0.0.1", "::1"}:
        return value
    return f"pvx-{namespace[:12]}.{value}"


def namespace_string(
    value: str, namespace: str, uri_replacements: dict[str, str]
) -> str:
    transformed = value
    placeholders: dict[str, str] = {}
    for index, original in enumerate(
        sorted(uri_replacements, key=len, reverse=True)
    ):
        placeholder = f"PVXURI{index:04d}PLACEHOLDER"
        if original in transformed:
            transformed = transformed.replace(original, placeholder)
            placeholders[placeholder] = uri_replacements[original]
    transformed = namespace_tokens(transformed, namespace)
    transformed = namespace_base64_runs(transformed, namespace)
    for placeholder, replacement in placeholders.items():
        transformed = transformed.replace(placeholder, replacement)
    return transformed


def namespace_payload(
    value: str, namespace: str, uri_replacements: dict[str, str]
) -> str:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        transformed = namespace_string(value, namespace, uri_replacements)
        return f"{transformed}\n[pvx-sample-run:{namespace}]"

    # Rewrite string values, never JSON object keys. Tool argument keys are
    # part of the action schema and changing them would change the scenario.
    namespaced = replace_strings_in_values(
        parsed, namespace, uri_replacements
    )
    namespaced = add_run_marker(namespaced, namespace)
    return serialize_payload_for_isolation(namespaced)


def serialize_payload_for_isolation(value: Any) -> str:
    """Serialize JSON without letting field names masquerade as entity ids.

    The deployed payload-token linker scans the raw JSON string rather than
    parsed values. A schema key such as ``body_base64`` satisfies its
    prefix-id heuristic and can therefore join unrelated replays. Escaping the
    first separator in identifier-shaped object keys is JSON-semantic: a parser
    still receives the exact original key, while the raw token scanner no
    longer mistakes schema vocabulary for customer data.
    """

    if isinstance(value, dict):
        members: list[str] = []
        for key, item in value.items():
            if not isinstance(key, str):
                raise AssertionFailure("JSON object key must be a string")
            encoded_key = json.dumps(key, ensure_ascii=False)
            if is_prefix_id(key):
                separator = min(
                    position
                    for position in (key.find("-"), key.find("_"))
                    if position >= 0
                )
                encoded_key = (
                    f'"{key[:separator]}\\u{ord(key[separator]):04x}'
                    f'{key[separator + 1:]}"'
                )
            members.append(
                f"{encoded_key}:{serialize_payload_for_isolation(item)}"
            )
        return "{" + ",".join(members) + "}"
    if isinstance(value, list):
        return "[" + ",".join(serialize_payload_for_isolation(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def add_run_marker(value: Any, namespace: str) -> Any:
    """Add explicit harness metadata without changing attack-relevant values."""

    if isinstance(value, dict):
        if RUN_MARKER_KEY in value:
            raise AssertionFailure(
                f"fixture payload already uses reserved key {RUN_MARKER_KEY}"
            )
        return {**value, RUN_MARKER_KEY: namespace}
    if isinstance(value, list):
        result = copy.deepcopy(value)
        for index, item in enumerate(result):
            if isinstance(item, dict):
                result[index] = add_run_marker(item, namespace)
                return result
        # No public fixture reaches this branch. Keep it deterministic and
        # explicit if a future primitive-only array is added.
        return [*result, {RUN_MARKER_KEY: namespace}]
    return {"value": value, RUN_MARKER_KEY: namespace}


def replace_strings_in_values(
    value: Any, namespace: str, uri_replacements: dict[str, str]
) -> Any:
    if isinstance(value, str):
        return namespace_string(value, namespace, uri_replacements)
    if isinstance(value, list):
        return [
            replace_strings_in_values(item, namespace, uri_replacements)
            for item in value
        ]
    if isinstance(value, dict):
        return {
            key: replace_strings_in_values(item, namespace, uri_replacements)
            for key, item in value.items()
        }
    return value


def iter_attribute_objects(document: dict[str, Any]):
    for resource in document.get("resourceSpans", []):
        for attribute in resource.get("resource", {}).get("attributes", []):
            yield attribute
        for scope in resource.get("scopeSpans", []):
            for span in scope.get("spans", []):
                for attribute in span.get("attributes", []):
                    yield attribute


def isolate_fixture(document: dict[str, Any], namespace: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{16,64}", namespace):
        raise AssertionFailure("fixture namespace must be 16-64 lowercase hex characters")
    isolated = copy.deepcopy(document)
    trace_ids = {str(span.get("traceId", "")) for span in iter_spans(isolated)}
    if not trace_ids or any(not TRACE_ID_RE.fullmatch(trace_id) for trace_id in trace_ids):
        raise AssertionFailure("fixture contains an invalid trace id")
    replacements = {
        trace_id: hashlib.sha256(
            f"trace:{namespace}:{trace_id}".encode()
        ).hexdigest()[:32]
        for trace_id in trace_ids
    }
    isolated = replace_strings(isolated, replacements)

    uri_replacements: dict[str, str] = {}
    for attribute in iter_attribute_objects(isolated):
        if attribute.get("key") not in URI_IDENTITY_KEYS:
            continue
        value = attribute.get("value")
        if not isinstance(value, dict) or not isinstance(value.get("stringValue"), str):
            continue
        original = value["stringValue"]
        uri_replacements[original] = namespace_uri(original, namespace)
    host_replacements: dict[str, str] = {}
    for original, replacement in uri_replacements.items():
        try:
            original_host = urlsplit(original).hostname
            replacement_host = urlsplit(replacement).hostname
        except ValueError:
            continue
        if original_host and replacement_host and original_host != replacement_host:
            host_replacements[original_host] = replacement_host

    for attribute in iter_attribute_objects(isolated):
        key = attribute.get("key")
        value = attribute.get("value")
        if not isinstance(value, dict) or not isinstance(value.get("stringValue"), str):
            continue
        original = value["stringValue"]
        if key in URI_IDENTITY_KEYS:
            value["stringValue"] = uri_replacements[original]
        elif key in PAYLOAD_KEYS:
            value["stringValue"] = namespace_payload(
                original, namespace, uri_replacements
            )
        elif key in HOST_IDENTITY_KEYS:
            value["stringValue"] = host_replacements.get(
                original, namespace_host(original, namespace)
            )
        elif key in IDENTITY_KEYS:
            transformed = namespace_tokens(original, namespace)
            if transformed == original:
                transformed = f"{original}-pvx-{namespace[:8]}"
            value["stringValue"] = transformed
    return isolated


def isolate_delayed_pair(
    day0: dict[str, Any], day2: dict[str, Any], nonce: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not re.fullmatch(r"[0-9a-f]{16,64}", nonce):
        raise AssertionFailure("run nonce must be 16-64 lowercase hex characters")
    isolated_day0 = isolate_fixture(day0, nonce)
    isolated_day2 = isolate_fixture(day2, nonce)

    day0_resources = {
        value
        for span in iter_spans(isolated_day0)
        for key, value in span_attributes(span).items()
        if key == "gen_ai.data_source.id" and "agent_notes" in value
    }
    day2_resources = {
        value
        for span in iter_spans(isolated_day2)
        for key, value in span_attributes(span).items()
        if key == "gen_ai.data_source.id" and "agent_notes" in value
    }
    if len(day0_resources & day2_resources) != 1:
        raise AssertionFailure("isolated delayed-exfil pair lost its shared document id")
    return isolated_day0, isolated_day2


def isolate_run(
    scenarios: dict[str, Any], fixtures_dir: Path, out_dir: Path, nonce: str
) -> None:
    if not re.fullmatch(r"[0-9a-f]{16,64}", nonce):
        raise AssertionFailure("run nonce must be 16-64 lowercase hex characters")
    out_dir.mkdir(parents=True, exist_ok=False)
    for fixture_name in scenarios:
        group = "delayed" if fixture_name in {DAY0_NAME, DAY2_NAME} else fixture_name
        namespace = hashlib.sha256(f"{nonce}:{group}".encode()).hexdigest()[:32]
        isolated = isolate_fixture(load_json(fixtures_dir / fixture_name), namespace)
        write_json(out_dir / fixture_name, isolated)


def build_fixture_paths(
    scenarios: dict[str, Any], fixtures_dir: Path, day0: Path, day2: Path
) -> dict[str, Path]:
    paths = {name: fixtures_dir / name for name in scenarios}
    paths[DAY0_NAME] = day0
    paths[DAY2_NAME] = day2
    missing = [name for name, path in paths.items() if not path.is_file()]
    if missing:
        raise AssertionFailure(f"missing fixture files: {', '.join(missing)}")
    return paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    isolate = subparsers.add_parser("isolate")
    isolate.add_argument("--day0", type=Path, required=True)
    isolate.add_argument("--day2", type=Path, required=True)
    isolate.add_argument("--out-dir", type=Path, required=True)
    isolate.add_argument("--nonce", required=True)

    isolate_all = subparsers.add_parser("isolate-run")
    isolate_all.add_argument("--expectations", type=Path, required=True)
    isolate_all.add_argument("--fixtures-dir", type=Path, required=True)
    isolate_all.add_argument("--out-dir", type=Path, required=True)
    isolate_all.add_argument("--nonce", required=True)

    response = subparsers.add_parser("response")
    response.add_argument("--expectations", type=Path, required=True)
    response.add_argument("--fixture-name", required=True)
    response.add_argument("--fixture", type=Path, required=True)
    response.add_argument("--response", type=Path, required=True)
    response.add_argument("--tenant-id", required=True)

    audit = subparsers.add_parser("audit")
    audit.add_argument("--expectations", type=Path, required=True)
    audit.add_argument("--audit", type=Path, required=True)
    audit.add_argument("--fixtures-dir", type=Path, required=True)
    audit.add_argument("--day0", type=Path, required=True)
    audit.add_argument("--day2", type=Path, required=True)
    audit.add_argument("--tenant-id", required=True)
    audit.add_argument("--key-id", required=True)
    audit.add_argument("--run-start", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "isolate":
            day0, day2 = isolate_delayed_pair(
                load_json(args.day0), load_json(args.day2), args.nonce
            )
            args.out_dir.mkdir(parents=True, exist_ok=False)
            write_json(args.out_dir / DAY0_NAME, day0)
            write_json(args.out_dir / DAY2_NAME, day2)
            return 0

        if args.command == "isolate-run":
            isolate_run(
                load_expectations(args.expectations),
                args.fixtures_dir,
                args.out_dir,
                args.nonce,
            )
            return 0

        scenarios = load_expectations(args.expectations)
        if args.command == "response":
            expectation = scenarios.get(args.fixture_name)
            if not isinstance(expectation, dict):
                raise AssertionFailure(
                    f"no expectation for fixture {args.fixture_name}"
                )
            message = assert_response(
                fixture_name=args.fixture_name,
                fixture=load_json(args.fixture),
                response=load_json(args.response),
                expectation=expectation,
                tenant_id=args.tenant_id,
            )
            print(message)
            return 0

        fixture_paths = build_fixture_paths(
            scenarios, args.fixtures_dir, args.day0, args.day2
        )
        message = assert_audit_run(
            audit=load_json(args.audit),
            scenarios=scenarios,
            fixture_paths=fixture_paths,
            tenant_id=args.tenant_id,
            key_id=args.key_id,
            run_start=args.run_start,
        )
        print(message)
        return 0
    except AssertionFailure as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
