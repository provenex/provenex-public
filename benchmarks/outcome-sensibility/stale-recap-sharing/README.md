# Stale recap drives a confidential meeting share

This synthetic matched pair asks whether ordinary, individually successful
meeting-assistant actions make sense when their provenance and downstream
effect are joined:

```text
recap guidance -> meeting assistant -> confidential meeting notes -> external share
```

Both arms use the same five spans across the same four services, assistant,
confidential notes, composed recap text, recipient, Graph-shaped send, times,
and reconstructed edges. Only the retrieved recap's customer-classified
currentness changes. The frozen verdict grades its weakest lineage evidence
`metadata-proximity`; the reconstructed edges are not all claimed as directly
observed causal evidence.

| Arm | Recap URI classification | Production CLI result |
|---|---|---|
| Unsafe | `v1-superseded` -> `untrusted-external` | 1 assessed share, 1 Red; binding `stale-recap-private-meeting-share` |
| Clean twin | `v2-current` -> `internal` | 1 assessed share, 0 Red; `policy-cleared` |

The frozen, minimized output is in [`expected_projection.json`](expected_projection.json).
It includes the evaluated closure and SHA-256 hashes for both traces and both
configuration files.

## Exact reproduction

From a Provenex private-engine checkout containing this public bundle:

```bash
./demos/demo.sh scenario run stale-recap-sharing
cargo test --test stale_recap_sharing_cli -- --nocapture
```

The first command builds the production `provenex-scan` CLI if necessary,
scans both checked-in OTLP files from an isolated temporary working directory,
and fails if the matched result changes. The Rust regression invokes the same
CLI and compares its stable projection with the checked-in output.

## Scoped customer contract

[`config/trust_zones.yaml`](config/trust_zones.yaml) is load-bearing evidence,
not neutral fixture decoration. It declares one exact recap URI superseded for
current meeting shares, its replacement current, the transcript confidential,
and the send surface external. [`config/policies.yaml`](config/policies.yaml)
requires both the stale recap and confidential notes in the external action's
retained lineage.

Generic SaaS logs do not have a universal meaning for "superseded recap."
This demonstration does **not** claim that Provenex discovers native meeting
software version semantics from document text or an arbitrary vendor field.
In production, the customer must author or integrate the classification from
an authoritative content-lifecycle source and keep it current.

## Claim boundary

- All telemetry, services, people, content, and outcomes are repository-authored
  and synthetic. This is not a third-party incident record.
- The production CLI emits a signed retrospective assessment. No model runs,
  message is sent, action is held, or live request is blocked by this demo.
- The frozen verdict's weakest lineage-evidence grade is `metadata-proximity`;
  it is not a claim that every reconstructed edge was directly observed.
- The public bundle contains the telemetry, scoped config, hashes, and frozen
  result. The private Provenex engine is still required to rerun the assessment.
- One matched pair demonstrates mechanism behavior; it does not measure
  production prevalence, recall, or false-positive rate.
