# Meeting-recorder shadow activity: forgotten recorder versus managed twin

This repository-authored synthetic sandbox exercises a meeting assistant that
does not appear as a visible participant. A meeting-platform audit service
names `minutes-recorder` when it joins a confidential review, and a second
service observes that identity writing the transcript. The fixture does not
represent an incident involving any real meeting-assistant vendor.

The sandbox isolates the shadow-activity evidence boundary:

| Run | Inventory declaration | Exported recorder root | Recorded shadow result |
|---|---|---|---|
| [`unsafe`](unsafe/) | `complete`, with no authorized agents | absent | one `review` finding: a customer-configured identity authority saw an identity absent from the complete inventory |
| [`clean`](clean/) | `complete`, authorizing `agent://minutes-recorder` | present and parent-linked | no shadow-activity finding in the retained snapshot |
| [`partial-control`](partial-control/) over the unsafe trace | `partial`, with no matching entry | absent | `not-enough-evidence`; authorization is `not-established`, not `confirmed-unapproved` |

The unsafe and managed traces retain the same named recorder, meeting, join,
transcript write, bot-visibility marker, consent-notice marker, and retention
marker. The managed twin adds the exported invocation/root lineage and the
matching inventory entry. Its empty shadow result means only that this named
activity is explained by the observed lineage and loaded inventory. It does
**not** say the meeting was consensual, legally compliant, appropriately
retained, or otherwise safe.

## Evidence contract

- `meeting-platform-audit` is configured as an `agent_identity_authority`.
  Its resource-stamped service identity plus explicit `gen_ai.agent.name`
  supports **observed** identity evidence. The fixture cannot prove that a
  real collector authenticated that workload identity at ingest.
- `confirmed-unapproved` is intentionally narrow. It requires the configured
  identity-authority observation and the customer's explicit `complete` inventory
  declaration. Provenex does not independently prove inventory freshness or
  whole-estate coverage.
- The partial-inventory control receives the same unsafe telemetry, but absence
  is inconclusive. The report retains the observed identity evidence while
  downgrading the authorization conclusion to `not-established`.
- A self-authored agent name from a service outside the configured identity
  authorities would remain inferred evidence. This particular matched pair
  does not include that fourth control.
- The current shadow projection does not interpret the synthetic consent,
  visibility, meeting-classification, or retention attributes as policy or
  legal evidence. Those are explicit future engine gaps, not claimed catches.
- Shadow activity is report-only. It does not change a signed verdict and does
  not hold, block, remove, or prevent a recorder from joining.

## Reproduce the scan-path result

From the private Provenex engine checkout:

```text
cargo test --test meeting_recorder_shadow_sandbox
```

The regression launches the production scanner in structured-output mode three
times, using each scenario directory as its working directory. That exercises
normal customer config discovery, production OTLP ingestion,
`AssessmentService`, and the discovery/shadow projection. It normalizes only
stable shadow fields and compares them with
[`expected_projection.json`](expected_projection.json).

The public evidence mirror does not include the private engine, so an external
reader can inspect the telemetry and configuration boundary but cannot
independently execute the projection from this directory alone.
