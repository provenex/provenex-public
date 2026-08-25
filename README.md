# Provenex

This repository contains the public Provenex Check CLI, its interface
documentation, and synthetic evaluation material. The analysis engine is not
included: scoring and policy evaluation run on the hosted Provenex service.

## Run Provenex Check

Provenex Check requires Node.js 22 or newer. Start locally without an API key or
upload:

```sh
npx @provenex/check plan /path/to/project
npx @provenex/check capabilities
npx @provenex/check scan /path/to/project --dry-run
```

`plan` inventories eligible evidence on the local machine. `--dry-run` shows
the exact selection, categories, exclusions, destination, and byte limits
without loading a production key or sending a request.

To run the hosted analysis, request a Provenex API key, review the preflight,
and approve the upload:

```sh
export PROVENEX_API_KEY='replace-with-your-key'
npx @provenex/check scan /path/to/project
```

The CLI sends only the evidence shown in the approved preflight. It validates
the bounded public response and renders terminal, JSON, and HTML views locally.
See [public CLI onboarding](docs/onboarding.md) for the complete path and
[`cli/provenex-check/README.md`](cli/provenex-check/README.md) for every input
and safety control.

## Website example

[provenex.ai/check-app](https://provenex.ai/check-app) opens a static,
one-click Brightcart example result. It does not read, accept, mask, or upload
browser files. Use the CLI to analyze your own project or selected telemetry.

## Public boundary

- The CLI is a consent-first collector, hosted-analysis client, response
  validator, and local renderer.
- The proprietary engine, policies, correlation logic, and scoring stay
  server-side.
- The hosted request follows the versioned
  [`provenex-check-ephemeral-v1`](docs/provenex-check-data-policy.md) contract.
- The public response contains the public report contract, not engine source,
  private rule identifiers, or internal analysis structures.

## Edge distribution

No public Provenex Edge installation is available. Edge images, kits, registry
commands, and download credentials remain private and blocked from distribution
until:

1. the customer artifact no longer links the compiled private engine; and
2. every previously published source-leaking or engine-bearing image and kit
   has been retired.

Server-side scoring is the permanent product boundary. Do not use an archived
Edge command or artifact from an earlier document or repository revision. See
the [current install notice](docs/install.md).

## Repository guide

- [`docs/README.md`](docs/README.md): public documentation index.
- [`docs/provenex-check.md`](docs/provenex-check.md): product and report
  contract.
- [`docs/provenex-check-data-policy.md`](docs/provenex-check-data-policy.md):
  upload, processing, and retention contract.
- [`docs/telemetry-checklist.md`](docs/telemetry-checklist.md): supported
  telemetry inputs and fields.
- [`docs/what-provenex-cannot-see.md`](docs/what-provenex-cannot-see.md):
  coverage semantics.
- [`samples/`](samples/): synthetic disclosure-based telemetry fixtures.
- [`benchmarks/honest-mistakes/`](benchmarks/honest-mistakes/): matched
  synthetic unsafe and benign evidence pairs.
- [`docs/agentdojo-benchmark.md`](docs/agentdojo-benchmark.md): frozen
  company-reported benchmark evidence.

## Security

Do not place API keys, customer data, or private reports in issues. Report a
security concern to [security@provenex.ai](mailto:security@provenex.ai) as
described in [SECURITY.md](SECURITY.md).
