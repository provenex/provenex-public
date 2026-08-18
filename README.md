# Provenex evaluation materials

Customer-facing documentation and repository-owned synthetic fixtures for a
Provenex evaluation.

## Start here

- [`cli/provenex-check/`](cli/provenex-check/): the public, consent-first CLI
  collector for hosted source and telemetry checks. It contains no local
  Provenex analysis engine.
- [`docs/onboarding.md`](docs/onboarding.md): the single public end-to-end
  evaluation path, from connection and discovery through reviewed enforcement.
- [`docs/install.md`](docs/install.md): scoped installation and component
  reference for the local ingestor, workspace, and reverse proxy.
- [`docs/telemetry-checklist.md`](docs/telemetry-checklist.md): supported agent,
  HTTP, REST, RPC/gRPC, and audit-event telemetry shapes.
- [`docs/data-activity-ingest.md`](docs/data-activity-ingest.md): the
  sensor-neutral endpoint, browser, SaaS, DLP, EDR, SWG, and CASB metadata
  contract.
- [`docs/agentdojo-benchmark.md`](docs/agentdojo-benchmark.md): the frozen
  telemetry-scope funnel, current catch rates, misses, and control alert burden.
- [`benchmarks/honest-mistakes/`](benchmarks/honest-mistakes/): five
  policy-scoped, repository-authored unsafe/benign matched pairs with frozen
  file hashes and recorded offline results.
- [`docs/what-provenex-cannot-see.md`](docs/what-provenex-cannot-see.md): the
  blind-spots honesty contract.

## Data boundary

For customer telemetry, raw spans/events, topology, receipts, discovery
reports, and enforcement evidence stay on the customer-local Provenex Edge.
The Edge sends only a bounded, customer-keyed HMAC-minimized closure to the
hosted decision service's `/v1/score-closure`. Most shared evaluations use
`https://provenex-verdict.fly.dev`; a dedicated evaluation may receive another
origin, so use the Engine origin supplied with the customer's trial.

In the console, **Data boundary → Your data** shows the exact most recent
outbound scoring envelope. Do not configure an OTel exporter, the legacy
`provenex-ingest` forwarder, or a customer file upload to send raw telemetry to
the hosted Engine.

Provenex Check is a separate, explicit upload boundary: its public CLI previews
bounded source and export categories, obtains consent, and sends only that
one-run evidence to the central multi-tenant Check service under the displayed
retention policy. It is not the customer-local Edge path and must not be used as
a continuous production telemetry forwarder.

An authenticated Edge can import canonical OTLP and explicitly selected,
supported vendor-audit files. The caller selects the source format; Edge does
not sniff arbitrary dumps or poll vendor APIs. OAuth, pagination, cursors, and
continuous collection remain separate integrations.

## Synthetic detection appendix

[`samples/`](samples/) contains 13 repository-authored, disclosure-based
reconstructions plus a two-trace synthetic delayed-exfil scenario. The runner
may send only those 15 fixtures to staging with a designated demo key. This is
a detection-only appendix: it does not use customer data, prove that a named
vendor remains vulnerable, or prove that a reverse proxy blocked an action.

The current enforcement proof is a controlled customer-local mock run: the
same request is forwarded in observe mode (HTTP 200), then withheld before
delivery in enforce mode (HTTP 403), with an independently signed local PEP
receipt. It is not evidence that a real customer production action was gated.

## Superseded artifact

Historical revisions of this repository contained a `provenex-ingest` source
mirror that predates the customer-local Edge architecture and forwarded raw or
partially redacted telemetry centrally. It is not part of the current tree or
the current evaluation path. Use the supplied `provenex-edge` bundle instead.

## Security

Never put customer keys or payloads in issues. Send security disclosures to
security@provenex.ai. See [SECURITY.md](SECURITY.md) for the private-reporting
policy.
