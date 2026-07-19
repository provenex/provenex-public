# Installing the customer-local Provenex edge

The current evaluation bundle contains a local telemetry ingestor/workspace and
an HTTP reverse-proxy enforcement point. Raw telemetry, discovery state, and
signed action receipts remain in the evaluation environment. Only a bounded
ADR-008 scoring closure is sent to the common hosted scorer.

The older public `provenex-ingest` binary is superseded for customer
evaluations: it forwards raw or partially redacted OTLP centrally and does not
provide the local workspace or enforcement proxy described here.

## Recommended workstation installation

Prerequisites:

- a customer-specific, unexpired `pvx_trial_*` key;
- the Provenex console at `http://localhost:5173`;
- the loopback installer service supplied by the evaluation operator;
- free local ports 18080, 4318, and 8088; and
- a non-production upstream for the initial safe rehearsal.

In the console:

1. Open **Connect**.
2. Set the hosted scorer to `https://provenex-verdict.fly.dev`.
3. Enter the customer's key privately and choose **Test connection**.
4. Continue only when the UI shows reachable, authorized, and unexpired.
5. Open **Install Edge**, leave **Safe block rehearsal** checked, and start in
   `observe` mode.
6. Wait until local workspace, reverse proxy, and hosted scorer are all healthy.
7. Choose **Use local workspace**.

The installer retrieves the scorer's public Ed25519 verification key and
generates separate local secrets for HMAC pseudonymization, workspace auth,
edge signing, and PEP proof signing. Only the public verification material is
shared between components; private keys remain with their owner.

## Operator Compose installation

Operators working from the monorepo can use the equivalent Compose bundle:

```bash
cp deploy/edge/.env.example deploy/edge/.env
# Fill every placeholder through a secret manager. Do not commit this file.
docker compose --env-file deploy/edge/.env \
  -f deploy/edge/docker-compose.yml up --build
```

The example defaults the central scoring origin to
`https://provenex-verdict.fly.dev` and enforcement to `observe`. It does not
contain usable credentials. Do not reuse HMAC salts, database passwords, or PEP
keys between customers.

The local endpoints bind to loopback by default:

| Endpoint | Authentication | Purpose |
|---|---|---|
| `127.0.0.1:18080` | local edge bearer | report, verdict, custody, receipts |
| `127.0.0.1:4318/v1/traces` | local edge bearer | OTLP/HTTP JSON ingest |
| `127.0.0.1:8088` | request correlation | protected reverse proxy |

Do not publish these listeners directly to the Internet. Put any non-loopback
deployment behind the customer's network controls and secret manager.

## Readiness checks

```bash
curl -fsS \
  -H "Authorization: Bearer $PROVENEX_EDGE_API_TOKEN" \
  http://127.0.0.1:18080/readyz

curl -fsS http://127.0.0.1:8088/readyz
```

The edge readiness check includes the hosted scorer. HTTP 402 during setup
means the customer's trial expired; an unrevoked key is not necessarily an
unexpired one. Renew or reissue for that same customer.

## Connect telemetry

Point the customer's OTLP/HTTP exporter at the local receiver and authenticate
with `PROVENEX_EDGE_API_TOKEN`, not the trial key:

```bash
curl -fsS -X POST http://127.0.0.1:4318/v1/traces \
  -H "Authorization: Bearer $PROVENEX_EDGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @approved-export.otlp.json
```

The response confirms local receipt ingestion. Use the console's Discovery
view or authenticated local `/report` endpoint for findings. Do not POST the
file to `provenex-verdict.fly.dev` or `api.provenex.ai`.

Before real telemetry, inspect **Data Custody** and require a runtime-verified
outbound contract with no raw URI, hostname, prompt, body, email, correlation
key, receipt ID, or enforcement receipt.

## Enable enforcement safely

Start in observe mode. Put the protected client behind port 8088 and use the
installer-owned loopback sink first. The initial denied rehearsal must return
HTTP 200 and show that it was forwarded with an alert.

After policy review, switch the proxy to `enforce`, wait for readiness, and run
the exact same request. A trusted block is HTTP 403, `block`, not forwarded,
and a signed local PEP receipt. If any element is missing, return to observe and
do not claim live enforcement.

## Stop or reset the evaluation bundle

Use **Stop** in Install Edge for the workstation path. For Compose:

```bash
docker compose --env-file deploy/edge/.env \
  -f deploy/edge/docker-compose.yml down
```

This preserves the Postgres volume. Removing the volume deletes the local
customer workspace and must be an explicit, separately approved cleanup step.
