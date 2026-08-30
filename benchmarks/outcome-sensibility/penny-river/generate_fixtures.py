#!/usr/bin/env python3
"""Generate the deterministic Penny River unsafe/verified OTLP twins.

The large fixtures are generated rather than committed.  Apart from the
controller-stamped ``target.verified`` value, the two telemetry documents are
byte-for-byte structurally identical.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
DEFAULT_SETTLEMENTS = 1_000
DEFAULT_DUPLICATE_DELIVERIES = 10
DEFAULT_STATED_ATTEMPTS = 10
BASE_TIME_UNIX_NANO = 1_760_000_000_000_000_000
SERVICE_NAME = "penny-river-settlement-controller"
TARGET = "bank://fictional-beneficiary/rounding-account"


def attribute(key: str, value: str) -> dict[str, Any]:
    return {"key": key, "value": {"stringValue": value}}


def action_attributes(
    *,
    index: int,
    verified: bool,
    stage: str,
    settlement_index: int | None,
) -> list[dict[str, Any]]:
    if settlement_index is None:
        obligation = f"payment-attempt-{index:06d}"
        commitment = f"commitment-attempt-{index:06d}"
    else:
        obligation = f"invoice-{settlement_index:06d}"
        commitment = f"commitment-{settlement_index:06d}"

    values = [
        ("gen_ai.operation.name", "execute_tool"),
        ("gen_ai.tool.name", "release_vendor_payment"),
        ("provenex.action.context.protected", "true"),
        ("provenex.action.context.class", "financial-commitment"),
        ("provenex.action.context.commitment.stage", stage),
        ("provenex.action.context.target.resource", TARGET),
        ("provenex.action.context.target.verified", str(verified).lower()),
        ("provenex.action.context.amount.value", "0.01"),
        ("provenex.action.context.amount.currency", "USD"),
        ("provenex.action.context.subject.tenant", "merchant-001"),
        ("provenex.action.context.commitment.obligation", obligation),
        ("provenex.action.context.commitment.id", commitment),
    ]
    if settlement_index is not None:
        values.append(
            (
                "provenex.action.context.settlement.id",
                f"settlement-{settlement_index:06d}",
            )
        )
    return [attribute(key, value) for key, value in values]


def span(
    *,
    receipt_index: int,
    fact_index: int,
    verified: bool,
    stage: str,
    settlement_index: int | None,
) -> dict[str, Any]:
    return {
        "traceId": f"{receipt_index:032x}",
        "spanId": f"{receipt_index:016x}",
        "name": "execute_tool release_vendor_payment",
        "startTimeUnixNano": str(BASE_TIME_UNIX_NANO + fact_index * 1_000_000_000),
        "attributes": action_attributes(
            index=receipt_index,
            verified=verified,
            stage=stage,
            settlement_index=settlement_index,
        ),
    }


def telemetry(
    *, settlements: int, duplicate_deliveries: int, stated_attempts: int, verified: bool
) -> dict[str, Any]:
    spans = [
        span(
            receipt_index=index,
            fact_index=index,
            verified=verified,
            stage="settled",
            settlement_index=index,
        )
        for index in range(1, settlements + 1)
    ]

    # Re-deliver the first processor settlements under new span identities.
    # Their controller-stamped settlement facts remain identical, so the
    # aggregate must count them once rather than manufacture extra payments.
    for duplicate in range(1, duplicate_deliveries + 1):
        spans.append(
            span(
                receipt_index=settlements + duplicate,
                fact_index=settlements + duplicate,
                verified=verified,
                stage="settled",
                settlement_index=duplicate,
            )
        )

    for attempt in range(1, stated_attempts + 1):
        receipt_index = settlements + duplicate_deliveries + attempt
        spans.append(
            span(
                receipt_index=receipt_index,
                fact_index=receipt_index,
                verified=verified,
                stage="stated",
                settlement_index=None,
            )
        )

    return {
        "_scenario": (
            f"{settlements} independent one-cent settled payments converge on one "
            f"fictional destination; {duplicate_deliveries} duplicate deliveries and "
            f"{stated_attempts} stated-only attempts must not inflate the settled "
            "aggregate. The controller verification stamp is the matched variable."
        ),
        "_evidence_scope": (
            "Repository-authored synthetic OTLP. This is a deterministic mechanism "
            "test, not evidence of production frequency, fraud, or funds recovery."
        ),
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [attribute("service.name", SERVICE_NAME)]
                },
                "scopeSpans": [{"spans": spans}],
            }
        ],
    }


def encoded(document: dict[str, Any]) -> bytes:
    return (
        json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        + "\n"
    ).encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_matched_attribute(document: dict[str, Any]) -> tuple[dict[str, Any], int]:
    normalized = copy.deepcopy(document)
    changed = 0
    for resource_spans in normalized["resourceSpans"]:
        for scope_spans in resource_spans["scopeSpans"]:
            for current_span in scope_spans["spans"]:
                for current_attribute in current_span["attributes"]:
                    if current_attribute["key"] == (
                        "provenex.action.context.target.verified"
                    ):
                        current_attribute["value"]["stringValue"] = "<matched-variable>"
                        changed += 1
    return normalized, changed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory for the two generated OTLP files and manifest.json",
    )
    parser.add_argument("--settlements", type=int, default=DEFAULT_SETTLEMENTS)
    parser.add_argument(
        "--duplicate-deliveries", type=int, default=DEFAULT_DUPLICATE_DELIVERIES
    )
    parser.add_argument("--stated-attempts", type=int, default=DEFAULT_STATED_ATTEMPTS)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.settlements < 3:
        raise SystemExit("--settlements must be at least 3")
    if not 0 <= args.duplicate_deliveries <= args.settlements:
        raise SystemExit("--duplicate-deliveries must be between 0 and --settlements")
    if args.stated_attempts < 0:
        raise SystemExit("--stated-attempts must be non-negative")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    fixtures: dict[str, dict[str, Any]] = {}
    documents: dict[str, dict[str, Any]] = {}
    for arm, verified in (("unsafe", False), ("verified", True)):
        filename = f"penny-river-{arm}.otlp.json"
        document = telemetry(
            settlements=args.settlements,
            duplicate_deliveries=args.duplicate_deliveries,
            stated_attempts=args.stated_attempts,
            verified=verified,
        )
        documents[arm] = document
        payload = encoded(document)
        (args.output_dir / filename).write_bytes(payload)
        fixtures[arm] = {
            "file": filename,
            "sha256": sha256(payload),
            "bytes": len(payload),
            "target_verified": verified,
        }

    normalized_unsafe, unsafe_matched_attributes = normalize_matched_attribute(
        documents["unsafe"]
    )
    normalized_verified, verified_matched_attributes = normalize_matched_attribute(
        documents["verified"]
    )
    normalized_bytes = encoded(normalized_unsafe)
    if normalized_bytes != encoded(normalized_verified):
        raise AssertionError("generated arms differ outside target.verified")
    if unsafe_matched_attributes != verified_matched_attributes:
        raise AssertionError("generated arms carry different verification-stamp counts")

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "generator": "generate_fixtures.py",
        "measurement": "synthetic-settled-convergence-matched-twin",
        "scale": {
            "unique_settlements": args.settlements,
            "duplicate_deliveries": args.duplicate_deliveries,
            "stated_only_attempts": args.stated_attempts,
            "registered_actions_per_arm": (
                args.settlements + args.duplicate_deliveries + args.stated_attempts
            ),
            "settlement_receipts_sampled_per_arm": (
                args.settlements + args.duplicate_deliveries
            ),
            "amount_each": "0.01",
            "currency": "USD",
            "expected_unique_total": (
                f"{args.settlements // 100}.{args.settlements % 100:02d}"
            ),
        },
        "matched_difference": (
            "Only provenex.action.context.target.verified differs between arms."
        ),
        "matched_attribute_occurrences_per_arm": unsafe_matched_attributes,
        "normalized_shape_sha256": sha256(normalized_bytes),
        "fixtures": fixtures,
    }
    manifest_bytes = (
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    ).encode("utf-8")
    (args.output_dir / "manifest.json").write_bytes(manifest_bytes)
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
