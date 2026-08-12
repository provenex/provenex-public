# Provenex evaluation onboarding

This guide describes the current minimized-closure evaluation path. It begins
with discovery and can end with a controlled HTTP-boundary enforcement mock
run at a customer-local Provenex Edge.

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

Most shared evaluations currently use
`https://provenex-verdict.fly.dev`; dedicated evaluations may use another
Engine origin. Always use the origin and customer-specific expiring
`pvx_trial_*` key supplied for that evaluation. The key authenticates minimized
scoring and installed-Edge console sign-in; it is not an OTLP credential.

## Before installing

You need:

- the customer-specific trial key supplied privately by Provenex;
- Docker for the Compose path, or the workstation installer started by the
  Provenex operator;
- an approved historical telemetry export or an OTLP/gRPC or OTLP/HTTP source;
- a non-production upstream for the first reverse-proxy mock run; and
- for the operator workstation mock-run path only, `http://localhost:5173`
  available for its console. The customer-owned kit uses
  `http://127.0.0.1:18080/console/` instead.

Verify that the key is recognized and unexpired without showing it on screen:

```bash
export PROVENEX_ENGINE_URL='<Engine origin from the welcome email>'
export PROVENEX_TRIAL_API_KEY='pvx_trial_<customer-key>'

curl -fsS \
  -H "Authorization: Bearer $PROVENEX_TRIAL_API_KEY" \
  "$PROVENEX_ENGINE_URL/v1/health/key"
```

The response must identify the expected plan, show a future or null
`trial_expires_at`, and atomically publish a non-empty
`verdict_verify_key_id`, a 64-character hexadecimal
`verdict_verify_pubkey_hex`, and the expected `verdict_verify_key_scope`.
HTTP 401 means the key is missing or unknown, HTTP 402 means the tenant trial
expired, and HTTP 403 means the key or tenant is inactive/revoked. Ask Provenex
to repair the same customer's account rather than borrowing another trial key.

## Install the customer-local Edge

Choose the installation path that matches the evaluation.

### Customer-owned evaluation

From the supplied evaluation kit, run:

```bash
deploy/edge/bootstrap.sh --start
```

The helper validates the customer's trial key, pins the Engine signing-key
identity, creates independent local secrets, writes the mode-`0600`
environment file, and starts customer-local Postgres, Collector, and Edge in
`observe`. Nothing is put inline by the default installation.

Open `http://127.0.0.1:18080/console/`. Sign in with the customer's trial key
or the short-lived one-time pairing URL printed by bootstrap. Either route
yields a revocable 24-hour `pvx_console_…` browser session. The browser retains
neither the typed trial key nor the pairing code, and
`PROVENEX_EDGE_API_TOKEN` remains on the Edge host. Trial-key sign-in proves
possession of a shared credential; it is not individual identity or SSO.

### Controlled workstation mock run

The operator-driven console at `http://localhost:5173/?view=connect` is a
screen-share mock runner, not remote fleet management:

1. In **Connect Provenex Engine**, enter the supplied origin as **Engine URL**
   and paste the prospect's key into **Evaluation key**.
2. Choose **Verify & continue to Edge setup**.
3. In **Setup**, choose **Start demo Edge**. The installer starts in `observe`.
   If durable evidence or multi-day discovery is required, use the reviewed
   customer-controlled Postgres configuration; connectivity alone does not
   prove ownership or region.
4. Wait for the telemetry ingestor, receipt store, local workspace, reverse
   proxy, and hosted scorer to reach their expected healthy posture. Choose
   **Copy complete connection**, place the one-time endpoint/token directly in
   the customer secret manager, then choose **Open this Edge environment**. No
   secret-bearing browser download is offered; set mode `0600` immediately if
   copied values are written to a file.

The installer atomically pins the scorer's `verdict_verify_key_id`, Ed25519
public key, and `verdict_verify_key_scope`, then generates independent
customer-local HMAC, workspace, ingest-only, Edge-signing, and PEP proof
credentials. The PEP private key and HMAC salt never go to the shared scorer.

The installer shows the exact local endpoints after installation:

| Endpoint | Purpose |
|---|---|
| `http://127.0.0.1:<allocated>` | authenticated workspace/report API; port allocated dynamically |
| `http://<configured-ingest>/v1/traces` | authenticated OTLP/HTTP protobuf or JSON ingest |
| `http://<configured-proxy>` | reverse-proxy enforcement point |

On an installed Edge, the browser uses the revocable same-origin console
session described above. The controlled workstation guided-setup browser is
different: it temporarily stores the verified Engine connection long enough
to complete the install handshake. Use a dedicated profile and clear it after
the evaluation. Telemetry senders use the narrower
`PROVENEX_INGEST_API_TOKEN` returned once during installation. Do not set a
local workspace or ingest token to the central trial key.

## Inspect the data boundary

Before importing customer data, open **Data boundary → Your data**. It must show a
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

In **Discovery → Telemetry profile and readiness → Import telemetry
history**, select the customer-approved source format before choosing files.
Imports are observe-only. An authenticated Edge that advertises local HTTP
ingest accepts canonical OTLP plus explicitly selected supported native audit
formats. The browser posts native audit files to
`/v1/vendor-audit?format=...`; it does not convert them to OTLP.

When an Edge's public origin advertises report-only mode, post supported dumps
to its separate private vendor-audit listener with the ingest-only token, then
refresh Discovery. Never send a native audit dump to the hosted Engine.
Unsupported files must produce a format/adapter gap rather than a
successful-looking Green result. Glean native CSV remains unsupported. See the
[telemetry checklist](telemetry-checklist.md) and use the formats advertised by
that Edge's `/v1/capabilities` as the runtime source of truth.

A common evaluation starts with roughly two weeks of exports to establish:

- observed services, agents, identities, and destinations;
- topological paths to egress or privileged actions;
- coverage gaps and unresolved telemetry shapes; and
- reviewable trust-zone and policy suggestions.

Frequency proves reachability, not trust. Suggestions and UI review are not
activation. The local edge cannot change the live policy, and the shared scorer
has no customer-specific override. Use the pre-provisioned common demo rules or
deploy a reviewed, digest-verified dedicated scorer for prospect-specific
policy, then repeat the observe-mode mock run.

## Switch to live ingest

After historical discovery, point the customer's canonical OTLP exporter at
the local Edge, never at the hosted Engine. A minimal OTel Collector exporter
is:

```yaml
exporters:
  otlphttp/provenex_edge:
    endpoint: http://127.0.0.1:4318
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
the same pipeline; Provenex is an additional local consumer. The live receiver
accepts OTLP/HTTP protobuf or JSON, and the customer-shaped Compose gateway
also accepts OTLP/gRPC on `4317`.

File/direct vendor-audit ingestion is a historical or scheduled-import lane;
it is not a streaming vendor connector. Provenex does not currently supply
automatic Compliance, Purview, Slack, or Glean API polling, OAuth, pagination,
cursor management, or backfill orchestration.

## Prove observe, then enforce

Use the installer-owned loopback sink for the controlled request so no external
system receives it. The setup-page mock-run buttons were removed; the Provenex
operator drives the paired request through the installer's loopback exercise
route.

In `observe` mode, send the request and require:

- HTTP 200;
- action `alert`;
- forwarded `yes`; and
- a signed local receipt showing the risk was not enforced.

Inspect **Data boundary → Your data** and verify the exact minimized envelope.
Then choose **Enable enforcement**, confirm the warning, wait for the proxy to
return healthy, and send the same request again. Require:

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
- Trial-key console sign-in authenticates possession, not an individual
  operator; native OIDC/SSO is not shipped.
- Native audit imports prove only what the exported records contain. Many
  audit formats lack parent-child causal links or outbound destination spans,
  so findings may remain inferred or not covered.
- Policy suggestions do not activate from the browser or local edge. The shared
  scorer has no customer-specific override; prospect-specific policy requires a
  reviewed dedicated-scorer release.
- The workstation installer is a controlled mock-run supervisor, not a remote
  Compose, Kubernetes, upgrade, or fleet manager.
- No real customer production action has yet been gated.
- Repository-owned Shopify and cross-trace IDOR scenarios are retrospective
  detection appendices, not inline 403 demonstrations.

Read [what Provenex cannot see](what-provenex-cannot-see.md) before treating a
Green verdict as complete coverage.
