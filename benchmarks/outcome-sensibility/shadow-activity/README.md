# Shadow activity: authorized twin versus unexplained child launch

This synthetic matched pair exercises Provenex's report-only shadow-activity
projection. Both traces contain an authorized settlement orchestrator, an
explicit `spawn_agent` lifecycle action, a named `payout-rounder` child, and a
downstream one-cent payout tool call. The pair changes only the evidence needed
to explain and authorize the child:

| Fixture | Complete inventory | Child-bound delegation | Recorded advisory |
|---|---|---|---|
| [`unsafe_trace.otlp.json`](unsafe_trace.otlp.json) | authorizes only `settlement-orchestrator` | absent | one review finding: child launch is observed and the trusted child identity is absent from the complete inventory |
| [`clean_twin_trace.otlp.json`](clean_twin_trace.otlp.json) | authorizes both named agents | directly linked to the child | no shadow-activity finding in the observed snapshot |

The customer declarations used for each side are
[`unsafe_inventory.yaml`](unsafe_inventory.yaml) and
[`clean_inventory.yaml`](clean_inventory.yaml). `agent-control-plane` is a
configured identity authority, so its explicit `gen_ai.agent.name` observation
can be treated as trusted identity evidence. That declaration assumes the
collector binds `service.name` to an authenticated workload; this fixture does
not prove that deployment control.

## Recorded output

[`summary.json`](summary.json) is the deterministic structured projection for
the two fixtures at a fixed evaluation time using Provenex engine source commit
`aaf195784c538e2ab839dc4aa48a134ec6a33c3a`. The unsafe result is
`advisory-only`, `review`, `observed`, and `confirmed-unapproved`. In this
artifact, `confirmed-unapproved` has a narrow meaning: the trusted identity is
absent from the loaded customer configuration whose coverage is declared
`complete`. Provenex does not independently prove that the inventory is fresh
or covers the customer's whole estate.

The clean result contains zero findings. That means no candidate surfaced in
this retained telemetry under the matching authorized inventory and direct
delegation. It is not proof that no unobserved activity exists.

## What this pair demonstrates

- A root agent with no incoming lineage is not called a shadow agent.
- A trusted, explicit identity plus a complete inventory can support a concrete
  inventory mismatch; a self-authored name or partial inventory cannot.
- A lifecycle-to-child parent path can establish that the launch was observed,
  while the absence of a child-bound delegation is reported as missing launch
  authority evidence.
- The matching inventory entry recognizes the child as allowed, while the
  directly linked delegation explains the launch. The projection does not
  invent a hidden actor or rewrite either fixture's observed topology.
- The projection remains separate from verdict and enforcement paths. Nothing
  in this fixture was blocked, prevented, or held by the shadow-activity report.

## Reproduction boundary

The Provenex source regression is:

```text
cargo test --test shadow_activity_flagship
```

That test ingests both public OTLP files through the production OTLP adapter,
loads both customer configurations through the production trust resolver, runs
the shadow-activity projection with a fixed clock, and compares its structured
output and SHA-256 fixture hashes to `summary.json`.

This public evidence directory does not contain the Provenex engine source, so
the engine result cannot be independently executed from the public repository
alone. Readers can still audit the one-to-one telemetry/configuration
difference and verify the recorded file hashes. This is synthetic evidence of
the tested mechanism, not a claim about real-world frequency, recall, or a
third-party incident.
