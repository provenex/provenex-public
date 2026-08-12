# Installing the customer-local Provenex edge

The customer-shaped evaluation bundle contains a local OpenTelemetry Collector,
Postgres receipt store, telemetry ingestor/workspace, and an optional HTTP
reverse-proxy enforcement point. Raw telemetry, discovery state, and signed
action receipts remain in the evaluation environment. Only a bounded ADR-008
scoring closure is sent to the common hosted scorer.

The older public `provenex-ingest` binary is superseded for customer
evaluations: it forwards raw or partially redacted OTLP centrally and does not
provide the local workspace or enforcement proxy described here.

This is a scoped installation reference. Follow
[evaluation onboarding](onboarding.md) for the single observe-first customer
journey through discovery, review, and enforcement.

## Choose the installation path

### Customer-owned evaluation

From the supplied evaluation kit, run:

```bash
deploy/edge/bootstrap.sh --start
```

The helper validates the customer's trial key, pins the Engine signing-key
identity, creates independent local secrets, writes the mode-`0600`
environment file, and starts customer-local Postgres, Collector, and Edge in
`observe`. No customer traffic is routed through the enforcement proxy by
default.

Open `http://127.0.0.1:18080/console/`. Sign in with the customer's trial key
or with the short-lived one-time pairing URL printed by bootstrap. Either route
yields a revocable 24-hour `pvx_console_…` browser session. The browser retains
neither the typed trial key nor the pairing code, and
`PROVENEX_EDGE_API_TOKEN` remains on the Edge host.
Trial-key sign-in authenticates possession of a shared credential, not an
individual person; it is not SSO. Use the pairing route when distributing the
trial key to operators is undesirable.

### Controlled workstation mock run

The operator-driven console at `http://localhost:5173` is a screen-share mock
runner, not remote fleet management. Enter the supplied **Engine URL** and
**Evaluation key**, choose **Verify & continue to Edge setup**, then in
**Setup** choose **Start demo Edge**. After health checks pass, use **Copy
complete connection**, save the one-time ingest material in a secret manager,
and choose **Open this Edge environment**.

Unlike installed-Edge same-origin sign-in, this guided workstation lane stores
the verified Engine connection in the dedicated browser profile long enough to
complete installation. Treat that profile as credential-bearing and clear it
after the evaluation.

### What the customer-owned bundle starts

The supplied bundle starts customer-local Postgres, Provenex Edge, and an
OpenTelemetry Collector gateway accepting OTLP/gRPC on `4317` and OTLP/HTTP on
`4318`. Add the explicit `enforcement` profile only for a reviewed
HTTP-boundary exercise.

The shared Engine is the default. Set the non-secret
`PROVENEX_SCORE_ENDPOINT` supplied with the kit when the customer has a
dedicated Engine. The bundle contains no usable credentials and must not reuse
HMAC, database, workspace, ingest, Edge-signing, or PEP secrets between
deployments.

The local endpoints bind to loopback by default:

| Endpoint | Authentication | Purpose |
|---|---|---|
| `127.0.0.1:18080` | local edge bearer | report, verdict, custody, receipts |
| `127.0.0.1:4317` | loopback network boundary | Collector OTLP/gRPC ingest |
| `127.0.0.1:4318` | loopback network boundary | Collector OTLP/HTTP protobuf ingest |
| `127.0.0.1:8088` | request correlation | protected reverse proxy |

Do not publish these listeners directly to the Internet. Put any non-loopback
deployment behind the customer's network controls and secret manager.

## Readiness checks

```bash
curl -fsS \
  -H "Authorization: Bearer $PROVENEX_EDGE_API_TOKEN" \
  http://127.0.0.1:18080/readyz

# Only after starting the optional enforcement profile:
curl -fsS http://127.0.0.1:8088/readyz
```

The edge readiness check includes the hosted scorer. HTTP 402 during setup
means the customer's trial expired; an unrevoked key is not necessarily an
unexpired one. Renew or reissue for that same customer.

## Connect telemetry

The Compose gateway accepts normal OTLP/gRPC or OTLP/HTTP on loopback without
putting the central trial key in an application. For the workstation
installer's direct receiver, use the exact endpoint shown after install and its
separate one-time ingest-only token:

```bash
curl -i -X POST "$PROVENEX_EDGE_INGEST_URL" \
  -H "Authorization: Bearer $PROVENEX_INGEST_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @approved-export.otlp.json
```

The protocol-correct success body is `{}`. Confirm local receipt ingestion from
the `x-provenex-receipts-ingested` response header and verify
`x-provenex-custody: customer-local`; use Discovery or authenticated local
`/report` for findings. Do not POST the file to the hosted Engine.

Before real telemetry, inspect **Data boundary → Your data** and require a
runtime-verified outbound contract with no raw URI, hostname, prompt, body,
email, correlation key, receipt ID, or enforcement receipt.

## Import supported vendor audit files

When the authenticated Edge advertises vendor-audit ingestion in
`GET /v1/capabilities`, Discovery's **Import telemetry history** view offers
canonical OTLP plus explicitly selected supported audit formats. The current
browser lists Slack Enterprise, ChatGPT Enterprise, Google Workspace, GitHub,
Salesforce, Okta, AWS Bedrock, Microsoft 365 Copilot, Anthropic, and Shopify.
The **ChatGPT Enterprise** selector is a legacy label: its `format=chatgpt`
parser accepts the OpenAI API Platform organization audit-log management-event
shape, not current ChatGPT Compliance Logs or conversation-message logs.

When an Edge's public origin advertises report-only mode, post a supported dump
to its separate private ingest listener. Derive that origin from the
provisioned trace URL:

```bash
PROVENEX_EDGE_INGEST_ORIGIN="${PROVENEX_EDGE_INGEST_URL%/v1/traces}"
curl -i -X POST \
  "$PROVENEX_EDGE_INGEST_ORIGIN/v1/vendor-audit?format=slack" \
  -H "Authorization: Bearer $PROVENEX_INGEST_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @approved-slack-audit.json
```

Use the format list returned by that Edge's `/v1/capabilities` as the runtime
source of truth. The restricted ingest token, not the workspace token or trial
key, authenticates the private listener. `data-activity` is also available for
the documented [sensor-neutral contract](data-activity-ingest.md). This is
explicit file/direct ingest, not automatic format detection or live vendor-API
collection. Glean native CSV remains unsupported.

## Enable enforcement safely

The setup-page observe/block buttons were removed. The Provenex operator drives
the same controlled request through the installer's loopback exercise route.

1. In `observe`, send the controlled request and require HTTP 200, `alert`,
   forwarded `yes`, and enforced `no`.
2. Inspect **Data boundary → Your data** and verify the exact minimized
   envelope.
3. In **Setup**, choose **Enable enforcement**, confirm the HTTP 403 warning,
   and wait for proxy health.
4. Repeat the same exercise and require HTTP 403, `block`, forwarded `no`, and
   enforced `yes`.
5. In **Enforcement**, verify the matching independently signed local PEP
   receipt.

Do not describe historical import, Replay & Test, or a post-action Red result
as an inline block. This controlled mock run is not evidence that a real
customer production action has been gated.

## Stop or reset the evaluation bundle

Use **Stop** in Setup for the workstation path. For a customer-owned kit:

```bash
deploy/edge/bootstrap.sh --compose down
```

This preserves the Postgres volume. Removing the volume deletes the local
customer workspace and must be an explicit, separately approved cleanup step.
