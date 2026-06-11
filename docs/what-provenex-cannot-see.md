# What Provenex cannot see

Provenex's catch claims are structural and honest only if the blind spots
are stated with the same prominence. This page is the inverse of
our catch documentation. When a limit below is
central for your threat model, ask us: several have designed
mitigations on the roadmap, and we would rather tell you "not yet" than
let a diagram imply otherwise.

## Channels outside the telemetry

- **Uninstrumented egress.** A tool that talks to the network without
  emitting a span (raw `requests` call inside a tool body, a subprocess,
  an MCP server that isn't traced) never enters the lineage. Provenex
  surfaces *coverage gaps* for chains it can see ending abruptly, but a
  flow that is entirely off-telemetry is invisible. Mitigation: egress
  through the rung-3 proxy, which sees traffic regardless of spans.
- **Side channels.** Timing, token counts, error patterns, or any covert
  channel that does not move content through an observed span.
- **Human exfiltration.** An operator reading a screen and retyping.

## Losses inside the telemetry pipeline

- **Sampling and dropout.** Head sampling drops whole traces; per-span
  dropout breaks chains mid-flight. The engine answers `not_covered`
  rather than guessing (and we count honest not-covered outcomes per run), but a dropped chain is still an
  uncaught chain. Measured at 50%/10% sampling: strict recall ~0.48 vs
  ~0.62 over what survived (measured on our continuous evaluation harness).
- **Batching races.** Evidence can arrive after the question (first-pass
  enforcement). Bounded mitigations exist but a deployment that
  enables neither flush-before-gate nor the PDP wait will see NotCovered
  on first-pass requests.

## Classification blind spots

- **Bare-OTel telemetry has no zone signal.** With required-only
  attributes and no config, recall is zero by construction: measured and
  published, not hidden. The discovery-promotion onboarding pass is the
  designed fix (zero to roughly 0.70 recall in one pass on our evaluation corpus).
- **Paraphrased content.** Content predicates match values verbatim. An
  agent that rewrites PII ("the customer at the Folsom Street address")
  evades the content-crossed band; the structural catch still fires but
  severity is understated.
- **Compositional sensitivity.** Two individually-benign fields that are
  sensitive together (name + zip) are not modeled.
- **Source-call arguments.** Predicates classify tool *returns*; sensitive
  content passed *into* an unclassified tool is not content-classified.
- **Catch-all zone rules are deliberately ignored** as framework noise
 ; a customer who encodes real policy in `tool://*` gets
  suppression, not coverage. Use specific patterns.

## Identity and intent

- **Actor identity is as good as the telemetry's `enduser.id`.** Shared
  service accounts collapse distinct humans into one actor; spoofable
  attributes upstream of the collector are trusted as labeled.
- **Intent.** Provenex proves what flowed where, not why. A latent-path
  red says "this structure is one prompt away from a leak," not "this was
  an attack." Triage is the analyst's; the severity band is the assist.

## Scale and persistence limits

- **Novelty baselines cold-start** (30-day window): the first occurrence
  of anything is novel; a poisoned baseline (agent over-reaching for
  months) reads as normal.
- **Patient attackers across identity boundaries**: cross-agent sticky
  lookups exist, but decay tuning and cross-agent fan-out are open work
  (on the roadmap).

## How to read a green verdict

A green verdict means: *no policy fired on the lineage the engine could
reconstruct from the telemetry it received, under the classifications in
force.* Every clause in that sentence is a place reality can differ from
the model. The completeness attestation (spans emitted vs captured), the
`not_covered` discipline, and confidence degradation exist to keep those
clauses measurable instead of implicit.
