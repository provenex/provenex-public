# Provenex Check onboarding

The public Provenex path is the hosted Provenex Check CLI. The CLI selects
bounded local evidence, shows exactly what it would send, obtains approval,
calls the hosted service, validates the public response, and renders the result
locally. The engine remains server-side.

The website at [provenex.ai/check-app](https://provenex.ai/check-app) is a
static Brightcart example. It does not accept browser files and is not an
alternative upload client.

## 1. See the result, then check the local plan

Requirements:

- Node.js 22 or newer;
- an eligible project directory rather than the home directory itself; and
- a Provenex API key only when you choose to upload.

Run without installing a package globally:

```sh
npx @provenex/check demo
npx @provenex/check plan /path/to/project
npx @provenex/check capabilities
npx @provenex/check scan /path/to/project --dry-run
```

These commands do not need a production API key. `demo` renders the fixed
Brightcart result without reading project files or making a request. `plan`
inventories recognized project and evidence surfaces. `capabilities` explains
which inputs make each public result surface evaluable. `--dry-run` reads the
eligible selection and prints the full upload preflight without making a request.

Use `--list-files` when you want the dry run to list every selected
project-relative source path:

```sh
npx @provenex/check scan /path/to/project --dry-run --list-files
```

Review the selected categories, high-sensitivity paths, exclusions, artifact
paths, byte bounds, production origin, and data-policy identifier. Remove
anything you do not intend to submit with repeatable `--exclude` patterns.

## 2. Run the hosted check

Create a private output directory and load the API key from the environment:

```sh
mkdir -m 700 "$HOME/provenex-reports"
export PROVENEX_API_KEY='replace-with-your-key'

npx @provenex/check scan /path/to/project \
  --json "$HOME/provenex-reports/check.json" \
  --html "$HOME/provenex-reports/check.html"
```

The production CLI accepts the key from `PROVENEX_API_KEY` or an owner-only
configuration file. It does not accept production credentials as command-line
arguments. The CLI pins production uploads to `https://api.provenex.ai`.

Interactive runs show the final preflight and ask for approval. Automation must
add `--yes`; that flag approves the displayed upload only. It does not authorize
AI-history discovery. Use `--discover-ai-history` explicitly when automation
should include exact-project Claude Code or Codex sessions.

## 3. Add evidence deliberately

Source and configuration are the default scan surface. Add other evidence with
an explicit option:

```sh
npx @provenex/check scan /path/to/project \
  --session-input /path/to/session.jsonl \
  --telemetry /path/to/otel-traces.json \
  --dependency-audit /path/to/npm-audit.json \
  --dry-run
```

Use `audit` when the evidence also includes runtime or cost exports:

```sh
npx @provenex/check audit /path/to/project \
  --telemetry /path/to/otel-traces.json \
  --fly-log /path/to/fly.jsonl \
  --cloudwatch-log /path/to/cloudwatch.json \
  --aws-input /path/to/cost-and-usage.json \
  --dependency-audit /path/to/npm-audit.json
```

Every artifact appears in the preflight before consent. The CLI does not use
ambient AWS, Fly, or vendor credentials to discover evidence. Telemetry format
selection and supported session/export shapes are documented in the
[telemetry checklist](telemetry-checklist.md) and the
[CLI reference](../cli/provenex-check/README.md).

On an interactive terminal, `scan` and `audit` may perform bounded metadata-only
discovery for exact-project Claude Code and Codex sessions. The CLI reports
`found`, `none`, or `unavailable` and asks before including any full session.
Declining includes none. Non-interactive runs do not discover or include that
history unless `--discover-ai-history` is present.

## 4. Read the result

The report separates what was observed, what was inferred, and what was not
established. A source-only run is labeled as source-bounded. Runtime, identity,
cost, deployment, and agent behavior that were not supplied remain unevaluated.

JSON and HTML files are written only when requested. They are local,
user-controlled copies outside the hosted application's ephemeral processing
policy. Keep them outside the scanned project and protect them as private
reports.

The response signature verifies envelope self-consistency with the public key
included in that same response. It is not a durable Provenex issuer identity.
See [key and verification semantics](key-management.md).

## 5. Re-run after a change

Compare a new run with an owner-only prior JSON report:

```sh
chmod 600 "$HOME/provenex-reports/check.json"

npx @provenex/check scan /path/to/project \
  --verify-against "$HOME/provenex-reports/check.json" \
  --json "$HOME/provenex-reports/check-next.json" \
  --html "$HOME/provenex-reports/check-next.html"
```

The comparison is local. Results are `still-present` or `not-verifiable`; the
absence of a prior finding is not called fixed unless the public report carries
the stable verification identity required for that comparison.

## Public product boundary

The CLI does not include or download the Provenex engine. Hosted analysis
returns only the bounded public report. No public Edge install is available;
Edge distribution remains blocked under the [install notice](install.md).

The exact collection, consent, bounds, origin pinning, response validation, and
local-output behavior is maintained in
[`cli/provenex-check/README.md`](../cli/provenex-check/README.md). The hosted
processing contract is
[`provenex-check-ephemeral-v1`](provenex-check-data-policy.md).
