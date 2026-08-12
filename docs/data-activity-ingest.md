# Data activity ingest (`provenex.data-activity.v1`)

Provenex can join endpoint, browser, SaaS, email, DLP, EDR, SWG, and CASB
events to the same causal graph as OpenTelemetry and agent activity. A
customer-selected connector posts a vendor-neutral JSON envelope to the
customer-local Edge:

```text
POST /v1/vendor-audit?format=data-activity
Content-Type: application/json
Authorization: Bearer <customer-local ingest token>
```

This is an interchange contract, not a claim that Provenex ships an endpoint
agent for every operating system. The source sensor remains responsible for
observing the action. Provenex normalizes the event, maintains data-object
continuity, and makes the result available to lineage, policy, investigation,
and evidence workflows.

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
`event_id` is the cross-sensor identity and must be globally unique within the
customer workspace; namespace it with the sensor or vendor, such as `edr:...`
or `swg:...`. `lineage.parent_event_ids` uses those same global ids, which is
how an endpoint observation can directly parent a later browser or SaaS
observation.

The bounded source-native id remains visible in the local investigation
timeline so an analyst can pivot back to the originating sensor console.
Provenex uses a separate deterministic hashed receipt id internally.

## Object lineage

Provenex adds a causal edge when it can establish any of these relationships:

1. `lineage.parent_event_ids` names an earlier sensor event;
2. the same canonical `object.lineage_id` or `object.id` appears again;
3. `object.parent_id` names the source object of a ZIP, conversion, fragment,
   paste, or other derivative; or
4. the same exact SHA-256 content hash appears in another source, including an
   OTel, DLP, EDR, browser, or SaaS event.

Raw object ids are not globally trusted join keys. Without
`object.identity_namespace`, Provenex scopes an id to `source.vendor`, so two
unrelated products that both emit `file-1` cannot merge their graphs. A
connector may set the same explicit `identity_namespace` on both events only
when the customer has established that the namespace is shared across those
sensors. `object.parent_identity_namespace` provides the equivalent scope for
`parent_id`; when omitted, the parent defaults to the current source vendor.

The first three mechanisms preserve continuity when content changes. A content
hash establishes identical bytes, not semantic similarity: paraphrases and
OCR-equivalent but byte-different derivatives require an object or parent
identity from the sensor. Cross-source hash correlation accepts only the
contract's full `sha256:<64 lowercase hex>` identity. Provenex's default OTel
fallback is a short BLAKE3-derived identifier and is deliberately not treated
as equivalent. To join a DLP/SIEM OTLP event to that exact SHA-256, the emitter
must use the allowlisted external-signal path (`provenex.event` plus
`provenex.event.target.content_hash`) from a `service.name` configured in
`external_signal_services`; arbitrary customer OTLP cannot stamp the reserved
engine content-hash attribute directly.

Engine-created object and hash links choose the latest matching observation at
or before the child's event time. This prevents late delivery from turning a
stored future event into the child's parent. An explicit sensor parent that is
present later in the same request is rejected and counted. A parent id not yet
present remains an unverified source assertion because its event time cannot
be checked at ingest.

An optional sender-supplied `lineage.basis` may be one of:

- `sensor-observed`
- `object-id`
- `content-hash`
- `vendor-inferred`

That value describes only explicit `parent_event_ids`. Engine-created links
record separate provenance such as `parent-object-id`, `same-object-id`,
`document-lineage-id`, or `exact-content-hash`. Any inferred or asserted link
only adds context and suspicion; it never authorizes or clears an action.

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
completed. None of these values is a Provenex enforcement receipt: only the
signed PEP receipt path proves what a Provenex enforcement point did. V1
preserves and displays outcome but does not yet use it as a separate scoring or
policy axis.

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
identity, and `sensor-observed` are assertions made by the sender. The standard
Edge ingest credential authenticates the payload to one customer workspace;
v1 does not yet bind each assertion to a registered sensor identity or vendor
signing key. These assertions can add investigative context and suspicion;
they do not grant authorization or clear a policy finding.

Treat URI fields as evidence metadata, not a place for credentials. Strip
query tokens, bearer material, signed-download parameters, and unnecessary
personal identifiers before posting. Actor email, department, manager, object
names, destinations, and evidence locations remain customer-local but may
still be regulated metadata.

## Limits and honest failure

- The Edge HTTP body limit is 16 MiB and the parser also caps a request at
  100,000 events; the smaller bound wins, so connectors should batch well below
  100,000 for ordinary event sizes.
- Each activity may name at most 64 explicit parent events.
- Each object may carry at most 32 classifications and 32 fingerprints.
- Each activity may carry at most 16 evidence references.
- Content and evidence digests must be SHA-256.
- Semantically invalid rows are skipped with a local warning; an entirely
  invalid payload fails. V1 does not yet expose the skipped-row count as a
  structured response field. Envelope, schema, unknown-field, and top-level
  parse failures reject the whole request.

Cross-batch object and hash correlation is performed as each ingest is
assessed. Concurrent requests, or a predecessor that arrives only after its
later child, can miss an edge; v1 has no background repair or reconciliation
pass. PostgreSQL also performs separate result-bounded lookups per data-object
event rather than one batch join. Reconciliation, transactional or batched
indexed correlation, and connector-specific throughput validation are
required before treating this as high-volume endpoint-fleet telemetry.

An unobserved endpoint or browser action remains invisible. This adapter
increases the set of sensors Provenex can consume; it does not manufacture
telemetry a customer's sensor never recorded.

See the [telemetry checklist](telemetry-checklist.md) for OTLP attributes,
supported native audit formats, and the corresponding coverage limits.
