# Provenex evaluation onboarding

This guide describes the current ADR-008 evaluation path. It starts in
discovery mode and ends with a controlled live HTTP block at a customer-local
reverse proxy.

## What runs where

| Customer environment | Shared Provenex staging |
|---|---|
| Raw telemetry ingest and historical import | Stateless scoring only |
| Receipt/lineage graph and discovery report | `POST /v1/score-closure` |
| Decision cache (disabled in this release) | Signed judgment response |
| Reverse proxy and enforcement policy | Trial-key authentication |
| Signed PEP action receipts | No raw closure, receipt, or SIEM persistence for this route |

The common scorer is `https://provenex-verdict.fly.dev`. Each evaluating
customer receives a separate `pvx_trial_*` key. The key authenticates the local
edge to the scorer; it is not an OTLP ingest credential.

## Before installing

You need:

- the customer-specific trial key supplied privately by Provenex;
- Docker for the Compose path, or the workstation installer started by the
  Provenex operator;
- an approved historical telemetry export or an OTLP/HTTP source;
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
`verdict_verify_pubkey_hex`. HTTP 401 means the key is unknown or revoked. HTTP
402 means the tenant trial expired even if the key remains unrevoked; ask
Provenex to renew or reissue for that same customer.

## Install the customer-local edge

Open the console at `http://localhost:5173/?view=connect`:

1. Create an environment named for the prospect.
2. Enter `https://provenex-verdict.fly.dev` and the prospect's trial key.
3. Choose **Test connection**. Continue only when the scorer is reachable, the
   key is authorized, and the trial is unexpired.
4. Choose **Save & use**, then open **Install Edge**.
5. Keep **Safe block rehearsal** enabled and initial mode set to `observe`.
6. Install, wait for the local workspace, reverse proxy, and hosted scorer to
   become healthy, then choose **Use local workspace**.

The installer fetches the scorer's public verification key and generates
independent customer-local HMAC, workspace, edge-signing, and PEP proof keys.
The PEP private key and HMAC salt never go to the shared scorer.

Default local endpoints are:

| Endpoint | Purpose |
|---|---|
| `http://127.0.0.1:18080` | authenticated workspace/report API |
| `http://127.0.0.1:4318/v1/traces` | authenticated OTLP/HTTP JSON ingest |
| `http://127.0.0.1:8088` | reverse-proxy enforcement point |

The browser and collector authenticate locally with
`PROVENEX_EDGE_API_TOKEN`. Do not give either one the central trial key.

## Inspect the data boundary

Before importing customer data, open **Data Custody**. It must show a
runtime-verified v1 contract and the exact last outbound scoring request.

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
export. Imports are observe-only. Supported inputs include span-shaped agent
telemetry, traditional HTTP/REST/RPC service telemetry, and supported
audit-event exports. See the [telemetry checklist](telemetry-checklist.md).

A common evaluation starts with roughly two weeks of exports to establish:

- observed services, agents, identities, and destinations;
- topological paths to egress or privileged actions;
- coverage gaps and unresolved telemetry shapes; and
- reviewable trust-zone and policy suggestions.

Frequency proves reachability, not trust. A suggested or UI-approved policy is
not active until its configuration is deployed and its digest is verified.

## Switch to live ingest

After historical discovery, point the customer's exporter or adapter at the
local edge, never at the shared scorer. A minimal OTel Collector exporter is:

```yaml
exporters:
  otlphttp/provenex_edge:
    endpoint: http://provenex-edge.internal:4318
    headers:
      Authorization: "Bearer ${env:PROVENEX_EDGE_API_TOKEN}"

service:
  pipelines:
    traces:
      exporters: [otlphttp/provenex_edge]
```

Keep the customer's existing Datadog, Splunk, Honeycomb, or other exporter in
the same pipeline; Provenex is an additional local consumer. Connector-native
pulls from Datadog, Splunk, AWS, and other platforms need their corresponding
adapter. Exported files and OTLP/HTTP JSON are available in this release.

## Prove observe, then enforce

Use the installer-owned loopback sink for the first rehearsal so no external
system receives the request.

In `observe` mode, run **Safe rehearsal** and require:

- HTTP 200;
- action `alert`;
- forwarded `yes`; and
- a signed local receipt showing the risk was not enforced.

Then choose **Enable enforcement**, wait for the proxy to return healthy, and
run the same rehearsal again. Require:

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
- Policy suggestions do not hot-deploy from the browser.
- Repository-owned Shopify and cross-trace IDOR scenarios are retrospective
  detection appendices, not inline 403 demonstrations.

Read [what Provenex cannot see](what-provenex-cannot-see.md) before treating a
Green verdict as complete coverage.
