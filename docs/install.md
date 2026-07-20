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

## Recommended workstation installation

Prerequisites:

- a customer-specific, unexpired `pvx_trial_*` key;
- the Provenex console at `http://localhost:5173`;
- the loopback installer service supplied by the evaluation operator;
- available loopback ports for the operator-selected ingest and proxy listeners;
  the installer allocates the workspace port dynamically; and
- a non-production upstream for the initial safe rehearsal.

In the console:

1. Open **Connect**.
2. Set **Provenex hosted URL** to `https://provenex-verdict.fly.dev`, enter the
   customer's **Trial API key** privately, and choose **Connect & continue**.
3. Continue only when Overview shows **Hosted scorer connected**, then choose
   **Install Edge →**.
4. Leave **Start with safe demo traffic** checked. **Receipt storage** defaults
   to **automatic**: preconfigured Postgres when available, otherwise
   demo-only bounded memory. Before installation, use the advanced settings to
   select a verified customer-controlled Postgres URL for durable evidence;
   connectivity does not prove database ownership, account, or region.
5. Choose **Set up customer Edge →**. Installation starts in `observe`.
6. Wait until the telemetry ingestor, receipt store, local workspace, reverse
   proxy, and hosted scorer have their expected healthy posture. Choose
   **Copy telemetry config & open workspace →** and place the one-time secret
   config directly into the customer secret manager. The browser intentionally
   offers no secret-bearing file download; set mode `0600` immediately if the
   copied values are written to a file.

The installer retrieves the scorer's public Ed25519 verification key and
generates separate local secrets for HMAC pseudonymization, workspace auth,
edge signing, and PEP proof signing. Only the public verification material is
shared between components; private keys remain with their owner.

The successful install response shows the exact endpoints. The workspace uses
a dynamically allocated loopback port; ingest and proxy use the addresses the
operator selected. The fixed ports below apply only to the Compose package.

## Operator Compose installation

Operators working from the monorepo can use the equivalent Compose bundle:

```bash
install -m 600 deploy/edge/.env.example deploy/edge/.env
# Fill every placeholder through a secret manager. Do not commit this file.
docker compose --env-file deploy/edge/.env \
  -f deploy/edge/docker-compose.yml up --build
```

This starts Postgres, the Edge workspace, and a Collector gateway accepting
OTLP/gRPC `4317` plus OTLP/HTTP `4318`. Add `--profile enforcement` only when
installing the HTTP proxy in a reviewed request path.

The example defaults the central scoring origin to
`https://provenex-verdict.fly.dev` and enforcement to `observe`. It does not
contain usable credentials. Do not reuse HMAC salts, database passwords, or PEP
keys between customers.

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
`x-provenex-custody`; use Discovery or authenticated local `/report` for
findings. Do not POST the file to `provenex-verdict.fly.dev` or
`api.provenex.ai`.

Before real telemetry, inspect **Data Custody** and require a runtime-verified
outbound contract with no raw URI, hostname, prompt, body, email, correlation
key, receipt ID, or enforcement receipt.

## Enable enforcement safely

Start in observe mode. Put the protected client behind the displayed proxy
endpoint and use the installer-owned loopback sink first. Choose **Run observe
rehearsal**; the risky request must return HTTP 200 and show that it was
forwarded with an alert.

After discovery and policy review, choose **Enable enforcement**, wait for
readiness, and choose **Run block rehearsal**. A trusted block is HTTP 403,
`block`, not forwarded, and a signed local PEP receipt. If any element is
missing, return to observe and do not claim live enforcement.

## Stop or reset the evaluation bundle

Use **Stop** in Install Edge for the workstation path. For Compose:

```bash
docker compose --env-file deploy/edge/.env \
  -f deploy/edge/docker-compose.yml down
```

This preserves the Postgres volume. Removing the volume deletes the local
customer workspace and must be an explicit, separately approved cleanup step.
