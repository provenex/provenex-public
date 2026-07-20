# Provenex evaluation materials

Customer-facing documentation and repository-owned synthetic fixtures for a
Provenex evaluation.

## Start here

- [`docs/onboarding.md`](docs/onboarding.md): the single public end-to-end
  evaluation path, from connection and discovery through reviewed enforcement.
- [`docs/install.md`](docs/install.md): scoped installation and component
  reference for the local ingestor, workspace, and reverse proxy.
- [`docs/telemetry-checklist.md`](docs/telemetry-checklist.md): supported agent,
  HTTP, REST, RPC/gRPC, and audit-event telemetry shapes.
- [`docs/what-provenex-cannot-see.md`](docs/what-provenex-cannot-see.md): the
  blind-spots honesty contract.

## Data boundary

For actual customer telemetry, raw spans/events, topology, receipts, discovery
reports, and enforcement evidence stay on the customer-local ADR-008 edge. The
edge sends only a bounded closure containing customer-keyed HMAC tokens,
topology, coarse resource kinds/zones, coverage, timestamps, and allowlisted
signals to `https://provenex-verdict.fly.dev/v1/score-closure`. **Data Custody**
shows the exact most recent outbound JSON.

Do not configure an OTel exporter, the legacy `provenex-ingest` forwarder, or a
customer file upload to send raw telemetry to the shared scorer.

## Synthetic detection appendix

[`samples/`](samples/) contains 12 repository-owned attack reconstructions.
The runner may send only those fixtures to staging with a designated demo key.
This is a detection-only appendix: it does not use customer data and does not
prove that a reverse proxy blocked an action.

The live-block proof is the installed edge rehearsal: the same denied action is
forwarded in observe mode (HTTP 200), then withheld before upstream delivery in
enforce mode (HTTP 403), with a signed customer-local PEP receipt.

## Superseded artifact

The public `provenex-ingest` source mirror predates ADR-008 and forwards raw or
partially redacted telemetry centrally. It is retained for historical review,
not for current customer evaluations. Use the installer-provisioned
`provenex-edge` bundle instead.

## Security

Never put customer keys or payloads in issues. Send security disclosures to
security@provenex.ai.
