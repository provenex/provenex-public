# Provenex evaluation onboarding

This guide describes the current ADR-008 evaluation path. It starts in
discovery mode and ends with a controlled live HTTP block at a customer-local
reverse proxy.

This is the public end-to-end evaluation guide. The companion
[installation reference](install.md) supplies component detail; it does not
define a second meeting sequence.

## What runs where

| Customer environment | Shared Provenex staging |
|---|---|
| Raw telemetry ingest and historical import | Stateless scoring only |
| Receipt/lineage graph and discovery report | `POST /v1/score-closure` |
| Decision cache (disabled in this release) | Signed judgment response |
| Reverse-proxy posture and signed PEP action receipts | Shared policy release and trial-key authentication |
| Discovery and policy-review drafts | No raw receipt, report, or SIEM persistence for this route |

The common scorer is `https://provenex-verdict.fly.dev`. Each evaluating
customer receives a separate `pvx_trial_*` key. The key authenticates the local
edge to the scorer; it is not an OTLP ingest credential.

## Before installing

You need:

- the customer-specific trial key supplied privately by Provenex;
- Docker for the Compose path, or the workstation installer started by the
  Provenex operator;
- an approved historical telemetry export or an OTLP/gRPC or OTLP/HTTP source;
- a non-production upstream for the first reverse-proxy rehearsal; and
- `http://localhost:5173` available for the local console.

Verify that the key is recognized and unexpired without showing it on screen:

```bash
export PROVENEX_DEMO_ENGINE_URL='https://provenex-verdict.fly.dev'
export PROVENEX_DEMO_API_TOKEN='pvx_trial_<customer-key>'

curl -fsS \
  -H "Authorization: Bearer $PROVENEX_DEMO_API_TOKEN" \
  "$PROVENEX_DEMO_ENGINE_URL/v1/health/key"
```

The response must identify the expected plan, show a future or null
`trial_expires_at`, and publish a 64-character hexadecimal
`verdict_verify_pubkey_hex`. HTTP 401 means the key is missing or unknown, HTTP
402 means the tenant trial expired, and HTTP 403 means the key or tenant is
inactive/revoked. Ask Provenex to repair the same customer's account rather
than borrowing another trial key.

## Install the customer-local edge

Open the console at `http://localhost:5173/?view=connect`:

1. On **Start your evaluation**, enter
   `https://provenex-verdict.fly.dev` as **Provenex hosted URL** and paste the
   prospect's key into **Trial API key**.
2. Choose **Connect & continue**. Continue only when Overview shows **Hosted
   scorer connected**, then choose **Install Edge →**.
3. Keep **Start with safe demo traffic** enabled. **Receipt storage** defaults
   to **automatic**: preconfigured Postgres when available, otherwise
   demo-only bounded memory. Before installation, expand the advanced settings
   and select a verified customer-controlled Postgres URL for durable evidence
   or multi-day discovery; connectivity does not prove ownership or region.
4. Choose **Set up customer Edge →**. The installer always starts in
   `observe`.
5. Wait for the telemetry ingestor, receipt store, local workspace, reverse
   proxy, and hosted scorer to reach their expected healthy posture. Then choose
   **Copy telemetry config & open workspace →** and place the one-time
   endpoint/token directly into the customer secret manager. No secret-bearing
   browser download is offered; set mode `0600` immediately if the copied values
   are written to a file.

The installer fetches the scorer's public verification key and generates
independent customer-local HMAC, workspace, ingest-only, edge-signing, and PEP
proof credentials. The PEP private key and HMAC salt never go to the shared
scorer.

The installer shows the exact local endpoints after installation:

| Endpoint | Purpose |
|---|---|
| `http://127.0.0.1:<allocated>` | authenticated workspace/report API; port allocated dynamically |
| `http://<configured-ingest>/v1/traces` | authenticated OTLP/HTTP protobuf or JSON ingest |
| `http://<configured-proxy>` | reverse-proxy enforcement point |

The browser uses `PROVENEX_EDGE_API_TOKEN` for the workspace. Telemetry senders
use the narrower `PROVENEX_INGEST_API_TOKEN` returned once during installation.
Do not give either one the central trial key.

## Inspect the data boundary

Before importing customer data, open **Data Custody**. It must show a
runtime-verified v1 contract. The exact last outbound scoring request may
correctly be unavailable until the first protected action runs; historical
import does not send a scoring request centrally.

Permitted central fields are bounded to:

- customer-keyed HMAC tokens for receipts, resources, destination, and selected
  identity-bearing signals;
- topology edges between those tokens;
- coarse resource kinds, locally derived trust zones, timestamps, and coverage;
- a closed allowlist of normalized policy signals; and
- content-removal/privacy attestations.

Stop if the preview contains a raw URI or hostname, email, prompt, response
body, SQL, summary, correlation key, receipt ID, enforcement receipt, or an
unknown field. The HMAC salt and original values remain local.

## Run discovery on historical telemetry

In **Discovery → Import telemetry history**, select the customer's approved
canonical OTLP JSON/JSONL export. Imports are observe-only. This direct Edge
path supports span-shaped agent telemetry and traditional HTTP/REST/RPC service
telemetry. It does not auto-detect native vendor audit JSON/CSV. Those formats
can be assessed separately by a supported customer-local CLI scanner, but its
in-memory report does not feed the Edge. Edge import requires a separate,
reviewed converter that emits canonical OTLP; none is packaged for the native
audit adapters or Glean CSV. Never upload native dumps to the shared scorer as a
workaround. See the [telemetry checklist](telemetry-checklist.md).

A common evaluation starts with roughly two weeks of exports to establish:

- observed services, agents, identities, and destinations;
- topological paths to egress or privileged actions;
- coverage gaps and unresolved telemetry shapes; and
- reviewable trust-zone and policy suggestions.

Frequency proves reachability, not trust. Suggestions and UI review are not
activation. The local edge cannot change the live policy, and the shared scorer
has no customer-specific override. Use the pre-provisioned common demo rules or
deploy a reviewed, digest-verified dedicated scorer for prospect-specific
policy, then repeat the observe rehearsal.

## Switch to live ingest

After historical discovery, point the customer's canonical OTLP exporter at
the local edge, never at the shared scorer. Native audit scanner adapters do
not produce a stream for this receiver. A minimal OTel Collector exporter is:

```yaml
exporters:
  otlphttp/provenex_edge:
    endpoint: http://provenex-edge.internal:4318
    encoding: proto
    compression: none
    headers:
      Authorization: "Bearer ${env:PROVENEX_INGEST_API_TOKEN}"

service:
  pipelines:
    traces:
      exporters: [otlphttp/provenex_edge]
```

Keep the customer's existing Datadog, Splunk, Honeycomb, or other exporter in
the same pipeline; Provenex is an additional local consumer. Connector-native
pulls from Datadog, Splunk, AWS, and other platforms are not shipped. Supported
native audit files can be scanned separately with the local CLI, but only
canonical OTLP JSON/JSONL files can be imported into Edge in this release. The
live receiver accepts OTLP/HTTP protobuf or JSON, and the customer-shaped
Compose gateway also accepts OTLP/gRPC on `4317`.

## Prove observe, then enforce

Use the installer-owned loopback sink for the first rehearsal so no external
system receives the request.

In `observe` mode, choose **Run observe rehearsal** and require:

- HTTP 200;
- action `alert`;
- forwarded `yes`; and
- a signed local receipt showing the risk was not enforced.

Then choose **Enable enforcement**, confirm the warning, wait for the proxy to
return healthy, and choose **Run block rehearsal**. Require:

- HTTP 403;
- action `block`;
- forwarded `no`;
- enforced `yes`; and
- a signed receipt from this edge instance's independent PEP key.

The defensible claim is: the customer-local reverse proxy withheld the action
before upstream delivery, a fresh centrally signed minimized judgment
authorized the deny, and the local PEP independently signed proof of what it
did.

## Current limits

- The decision cache is off; every gated action needs a fresh central judgment.
- Inline blocking requires pre-action correlation. A client span exported only
  after the HTTP request cannot block that same request.
- The trusted live-block proof is the HTTP reverse proxy. Native gRPC
  interception is not the current demo claim.
- Policy suggestions do not activate from the browser or local edge. The shared
  scorer has no customer-specific override; prospect-specific policy requires a
  reviewed dedicated-scorer release.
- The loopback installer is a rehearsal supervisor, not a persistent remote
  fleet manager; restart/reprovision and upgrades remain follow-on work.
- Repository-owned Shopify and cross-trace IDOR scenarios are retrospective
  detection appendices, not inline 403 demonstrations.

Read [what Provenex cannot see](what-provenex-cannot-see.md) before treating a
Green verdict as complete coverage.
