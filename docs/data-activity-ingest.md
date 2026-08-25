# Data activity ingest (`provenex.data-activity.v1`)

Provenex can join endpoint, browser, SaaS, email, DLP, EDR, SWG, and CASB
events with explicitly selected OpenTelemetry and agent activity in a hosted
Provenex Check run. Supply the vendor-neutral JSON envelope as an explicit CLI
telemetry artifact:

```sh
npx @provenex/check scan /path/to/project \
  --telemetry /path/to/data-activity.json \
  --telemetry-format data-activity \
  --dry-run
```

This is an interchange contract, not a claim that Provenex ships an endpoint
agent for every operating system. The source sensor remains responsible for
observing the action. The hosted service normalizes the submitted event and may
use its object continuity in the bounded public report.

## Example

```json
{
  "schema": "provenex.data-activity.v1",
  "events": [
    {
      "event_id": "edr:01J5COPY",
      "observed_at": "2026-08-08T18:02:10Z",
      "action": "copy",
      "source": {
        "kind": "endpoint",
        "vendor": "customer-edr",
        "service": "endpoint-sensor",
        "application": "excel",
        "device_id": "device-7",
        "uri": "file:///Users/alice/forecast.xlsx"
      },
      "actor": {
        "id": "00u-alice",
        "email": "alice@example.com",
        "department": "Finance",
        "manager": "00u-manager",
        "risk_score": 42
      },
      "object": {
        "id": "file-8f31",
        "identity_namespace": "corp-data-catalog",
        "lineage_id": "dataset-quarterly-forecast",
        "name": "forecast.xlsx",
        "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "size_bytes": 184203,
        "content_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "fingerprints": ["edm:finance-forecast-v3"],
        "classifications": ["confidential", "financial"]
      },
      "outcome": "observed"
    },
    {
      "event_id": "swg:01J5UPLOAD",
      "observed_at": "2026-08-08T18:04:32Z",
      "action": "upload",
      "source": {
        "kind": "browser",
        "vendor": "customer-swg",
        "service": "secure-web-gateway",
        "application": "chrome",
        "device_id": "device-7"
      },
      "actor": {
        "id": "00u-alice",
        "email": "alice@example.com"
      },
      "object": {
        "id": "file-8f31",
        "identity_namespace": "corp-data-catalog",
        "lineage_id": "dataset-quarterly-forecast",
        "name": "forecast.xlsx",
        "content_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "destination": {
        "uri": "https://personal-drive.example/upload",
        "kind": "personal-saas",
        "tenant": "personal",
        "managed": false
      },
      "lineage": {
        "parent_event_ids": ["edr:01J5COPY"],
        "basis": "sensor-observed"
      },
      "outcome": "allowed"
    }
  ]
}
```

Bare arrays of events are accepted as a convenience. A wrapped payload must
carry the exact schema name so a future contract cannot be mistaken for v1.
`event_id` is the cross-sensor identity and must be unique within the submitted
request; namespace it with the sensor or vendor, such as `edr:...` or
`swg:...`. `lineage.parent_event_ids` uses those same ids, which is how an
endpoint observation can directly parent a later browser or SaaS observation.

## Object lineage

The v1 contract can establish continuity from these sender-visible signals:

1. `lineage.parent_event_ids` names an earlier sensor event;
2. the same canonical `object.lineage_id` or `object.id` appears again;
3. `object.parent_id` names the source object of a ZIP, conversion, fragment,
   paste, or other derivative; or
4. the same exact SHA-256 content hash appears in another source, including an
   OTel, DLP, EDR, browser, or SaaS event.

Without `object.identity_namespace`, an object id is scoped to `source.vendor`.
Set the same explicit namespace on events from different sensors only when the
customer has established that those sensors share that namespace.
`object.parent_identity_namespace` provides the equivalent scope for
`parent_id`; when omitted, the parent uses the current source vendor.

Object and parent identities can preserve continuity when content changes. A
content hash establishes identical bytes, not semantic similarity: paraphrases
and OCR-equivalent but byte-different derivatives require an object or parent
identity from the sensor. Hash continuity accepts only the contract's full
`sha256:<64 lowercase hex>` value; short or provider-local fingerprints are
not equivalent.

Continuity never permits a later observation to become an earlier event's
cause. Explicit future parents are rejected. A parent absent from the submitted
request remains an unverified sender assertion for that run.

An optional sender-supplied `lineage.basis` may be one of:

- `sensor-observed`
- `object-id`
- `content-hash`
- `vendor-inferred`

That value describes only explicit `parent_event_ids`. Derived continuity is
marked separately in results. Any inferred or asserted link adds context; it
never authorizes or clears an action.

## Supported vocabulary

Channels: `endpoint`, `browser`, `saas`, `email`, `network`, `file-system`,
`collaboration`, `ai-agent`.

Actions: `create`, `open`, `read`, `write`, `edit`, `copy`, `paste`, `move`,
`rename`, `upload`, `download`, `share`, `email`, `print`, `compress`,
`decompress`, `encrypt`, `decrypt`, `convert`, `screenshot`, `usb-write`,
`air-drop`, `prompt`, `response`, `tool-call`, `permission-change`, `delete`.

Outcomes: `observed`, `allowed`, `blocked`, `warned`, `failed`.

Outcome is what the source sensor reports. `blocked` and `failed` remain
visible as attempted-egress or control evidence and are not presented as
completed data movement. Conversely, `allowed` is not proof that delivery
completed. None of these values independently proves what a separate
enforcement point did. V1 preserves the source-reported outcome.

## Evidence and custody

Do not put raw file, message, clipboard, prompt, screenshot, or email content
in this payload. Unknown fields are rejected rather than silently ignored.
When a sensor captures forensic evidence, retain it in a customer-controlled
evidence repository and send a bounded reference:

```json
{
  "evidence": [
    {
      "kind": "screenshot",
      "uri": "s3://customer-evidence/case/event.png",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ]
}
```

The URI and digest become investigative evidence metadata. They do not create
a causal edge or content-hash join, and Provenex does not fetch or copy the
referenced bytes during ingest.

Source vendor, actor, classification, outcome, object identity, parent
identity, and `sensor-observed` are assertions made by the sender. The Provenex
API key authenticates the Check request to its tenant; v1 does not bind each
assertion to a registered sensor identity or vendor signing key. These
assertions add evidence context but do not grant authorization.

Treat URI fields as evidence metadata, not a place for credentials. Strip
query tokens, bearer material, signed-download parameters, and unnecessary
personal identifiers before approval. Actor email, department, manager, object
names, destinations, and evidence locations in this envelope are part of the
uploaded evidence and may be regulated metadata.

## Limits and failure semantics

- The CLI defaults to 16 MiB per telemetry artifact and caps an override at
  64 MiB; the selected request also has a 64 MiB aggregate content cap. The
  format parser accepts at most 100,000 events.
- Each activity may name at most 64 explicit parent events.
- Each object may carry at most 32 classifications and 32 fingerprints.
- Each activity may carry at most 16 evidence references.
- Content and evidence digests must be SHA-256.
- Semantically invalid rows may be skipped with a report warning; an entirely
  invalid payload fails. Envelope, schema, unknown-field, and top-level parse
  failures reject the whole artifact.

Parent events and object continuity must be present in the evidence submitted
for that run. A later request does not retroactively modify an earlier report.

An unobserved endpoint or browser action remains invisible. This adapter
increases the set of sensors Provenex can consume; it does not manufacture
telemetry a customer's sensor never recorded.

See the [telemetry checklist](telemetry-checklist.md) for OTLP attributes,
supported native audit formats, and the corresponding coverage limits.
