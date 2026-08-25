# Public documentation

## Start here

- [Provenex Check onboarding](onboarding.md): plan, dry-run, consented hosted
  analysis, evidence inputs, reports, and re-runs.
- [CLI reference](../cli/provenex-check/README.md): exact commands, bounds,
  exclusions, prompts, and response validation.
- [Product contract](provenex-check.md): public result and product boundary.
- [Data policy](provenex-check-data-policy.md): versioned hosted processing and
  retention contract.
- [Credentials and verification](key-management.md): API-key sources,
  production-origin pinning, response signatures, and local report files.

## Evidence inputs

- [Telemetry checklist](telemetry-checklist.md): supported formats and the
  fields that improve a hosted telemetry-assisted check.
- [Data activity contract](data-activity-ingest.md): sensor-neutral metadata
  input schema.
- [Coverage semantics](what-provenex-cannot-see.md): what missing or partial
  evidence means in a public report.

## Distribution boundary

- [Installation notice](install.md): the CLI is the supported public install;
  Edge distribution remains private and blocked.
- [Security policy](../SECURITY.md): private vulnerability reporting.

## Evaluation material

- [AgentDojo benchmark](agentdojo-benchmark.md): frozen company-reported
  telemetry replay result.
- [Public CLI case study](check-cli-oss-case-study.md): recorded source-only
  workflow over named public repositories.
- [Synthetic samples](../samples/README.md): disclosure-based telemetry
  reconstructions.
- [Matched honest-mistake fixtures](../benchmarks/honest-mistakes/README.md):
  synthetic unsafe and benign pairs.

The website at [provenex.ai/check-app](https://provenex.ai/check-app) displays a
static Brightcart example and does not accept browser files. Analysis of a user
project or selected telemetry starts in the CLI.
