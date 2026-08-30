# Outcome-sensibility demonstrations

These small, synthetic matched demonstrations test a different question from a
prompt-injection benchmark: can ordinary-looking actions or downstream traces
become reviewable only when the retained evidence is evaluated together?

Each demonstration includes an unsafe input and a deliberately similar clean
twin. The engine and policies are not published in this repository, so these
are company-reported, row-level evidence artifacts rather than an independently
reproducible third-party benchmark.

## Demonstrations

- [`penny-river/`](penny-river/): independently identified settlements
  converge on one destination. The unsafe run says destination verification
  failed; the clean twin says the same destination was independently verified.
- [`shadow-activity/`](shadow-activity/): the same orchestrator, child, launch,
  and downstream payment path is compared while the complete inventory and
  child-bound delegation evidence change.
- [`meeting-note-commitment/`](meeting-note-commitment/): the same approved
  meeting app, CRM record, active pricing rule, and 20% quote action are
  compared while the exported approval scope changes from a non-covering 10%
  grant to the exact 20% grant.
- [`outbound-write-delegation/`](outbound-write-delegation/): a provider-neutral
  accepted outbound write is compared under draft-only and exact publish scope
  for post-action Watch; a separate pre-action intent drives a controlled local
  Protect rehearsal with a generic PEP and counting sink.
- [`meeting-recorder-shadow/`](meeting-recorder-shadow/): downstream meeting
  and transcript services name the same recorder while complete, managed, and
  partial inventory/root-lineage evidence is compared.
- [`stale-recap-sharing/`](stale-recap-sharing/): the same meeting assistant,
  confidential notes, recipient, and external share are compared while a
  customer-classified recap changes from superseded to current.

## Claim boundary

- Every matched-pair result is retrospective. Penny River and both
  shadow-activity bundles are report-only projections. For the stale-recap,
  meeting-note commitment, and outbound-write Watch pairs, the scanner emitted
  signed verdicts; their frozen public projections retain only stable result
  fields. They do not demonstrate a live hold, block, or prevented action.
- The outbound-write bundle separately rehearses Protect with distinct
  pre-action synthetic intent, a loopback counting sink, the production local
  PDP, and the generic PEP. It proves a public-demo-key mechanism (observe adds
  one write; enforce adds zero and records a signed receipt), not a third-party
  integration, customer-key deployment, or authenticated production authority
  adapter.
- A review finding is not proof of fraud, compromise, intent, or a prevented
  action.
- Missing or incomplete destination, identity, inventory, lifecycle, or causal
  evidence is preserved as incomplete evidence rather than converted into a
  clean or unauthorized conclusion.
- Synthetic matched pairs demonstrate mechanism behavior. They do not measure
  incident prevalence, customer false-positive rates, or general precision and
  recall.
