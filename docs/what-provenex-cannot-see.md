# What Provenex cannot see

Provenex's catch claims are structural and honest only if the blind spots
are stated with the same prominence. This page is the inverse of
our catch documentation. When a limit below is
central for your threat model, ask us: several have designed
mitigations on the roadmap, and we would rather tell you "not yet" than
let a diagram imply otherwise.

This page assumes the current customer-local evaluation: raw telemetry and
receipts stay on Provenex Edge, while the hosted Engine sees only the bounded
HMAC-minimized closure displayed in **Data boundary → Your data**.

## Channels outside the telemetry

- **Uninstrumented egress.** A tool that talks to the network without
  emitting a span (raw `requests` call inside a tool body, a subprocess,
  an MCP server that isn't traced) never enters the lineage. Provenex
  surfaces *coverage gaps* for chains it can see ending abruptly, but a
  flow that is entirely off-telemetry is invisible. Mitigation: egress
  through the customer-local reverse proxy, which sees traffic regardless of
  whether the application emits an egress span.
- **A normal network span is not pre-action evidence.** HTTP client spans are
  commonly exported after the request completes. Blocking that same action
  requires an already-completed parent chain or a trusted pre-action/intent
  record before the request enters the proxy.
- **Action context exists only at trusted hooks.** Environment, credential,
  artifact, and promotion facts are not inferred from arbitrary egress. They
  must be emitted before execution by an authenticated controller or adapter in
  `action_context_authorities`. Direct or post-action paths may be visible for
  investigation without being preventively covered.
- **Side channels.** Timing, token counts, error patterns, or any covert
  channel that does not move content through an observed span.
- **Human exfiltration.** An operator reading a screen and retyping.

## Losses inside the telemetry pipeline

- **Sampling and dropout.** Head or tail sampling can remove whole traces and
  per-span dropout can break a chain. Provenex reports visible gaps and
  `not_covered` outcomes, but a fully dropped trace is structurally silent and
  missing telemetry remains an uncaught path. Do not publish a recall number
  without a frozen corpus, configuration, date, and machine-readable result.
- **Post-action telemetry cannot block the same action.** Evidence can arrive
  after the question. Inline enforcement therefore requires a pre-action
  correlation/intent record at the reverse proxy. A normal HTTP client span
  exported after completion remains discovery evidence only.
- **Native RPC enforcement is not shipped.** HTTP and RPC/gRPC spans contribute
  to discovery and detection, but the validated live deny boundary is the HTTP
  reverse proxy. Provenex does not yet intercept and deny a native gRPC call.
- **Assessment budgets are finite.** A scan with more egress candidates than
  the advertised per-scan budget assesses the highest-suspicion subset and
  reports the deferred tail. Narrow the window; do not treat the partial result
  as complete.

## Classification blind spots

- **Minimal OTLP may lack policy semantics.** Provenex can infer some resource
  and operation types from standard fields, but sparse telemetry may not carry
  a trustworthy source, destination, action, or zone classification. An
  inferred result is not equivalent to reviewed customer policy, and opaque
  resources remain a coverage gap.
- **Paraphrased content.** Content predicates match values verbatim. An
  agent that rewrites PII ("the customer at the Folsom Street address")
  can evade verbatim content evidence. Other topology or action evidence may
  still produce a finding, but detection and severity can also degrade.
- **Compositional sensitivity.** Two individually-benign fields that are
  sensitive together (name + zip) are not modeled.
- **Source-call arguments.** Predicates classify tool *returns*; sensitive
  content passed *into* an unclassified tool is not content-classified.
- **Catch-all zone rules are deliberately ignored** as framework noise; a
  customer who encodes real policy in `tool://*` gets suppression, not
  coverage. Use specific patterns.
- **Content-only outcomes are outside the primary action metric.** Prompt
  injection, refusal behavior, and unsafe text with no telemetry-visible
  protected action belong to prompt/content controls. Provenex complements
  those controls rather than replacing them.
- **External reads are not currently governed sinks.** Navigation and
  retrieval can be visible while remaining unassessed as protected actions.
  SSRF/navigation governance needs an explicit dual-role policy.
- **Unknown action semantics can remain unassessed.** A visible tool call whose
  operation has no registered protected-action meaning can fall through as an
  internal operation. A Green result does not prove that a deletion, booking,
  identity mutation, or another state change was authorized.

## Identity and intent

- **Actor identity is as good as the telemetry's `enduser.id`.** Shared
  service accounts collapse distinct humans into one actor; spoofable
  attributes upstream of the collector are trusted as labeled.
- **Typed action authority is only as strong as workload authentication.** An
  allowlisted `service.name` is not cryptographic identity. Bind trusted
  emitters with per-workload mTLS/credentials or a collector that overwrites
  caller-controlled identity, and protect the controller that derives the
  facts.
- **Intent.** Provenex proves what flowed where, not why. A latent-path
  red says "this structure is one prompt away from a leak," not "this was
  an attack." Triage is the analyst's; the severity band is the assist.

## Scale and persistence limits

- **Novelty baselines cold-start.** During the configured bounded baseline
  window, the first occurrence of anything is novel; a poisoned baseline
  (agent over-reaching for months) reads as normal.
- **Patient attackers need a stable identity join.** Sticky-Critical
  cross-agent co-lookup works only when both source families resolve to the
  same canonical user. Missing or inconsistent `enduser.id` values and absent
  identity-provider links remain invisible; decay and clearance tuning remain
  open work.
- **Cross-batch lineage needs a trustworthy object ID.** The same correctly
  namespaced logical object ID must appear on both events. `provenex.document.id`
  is a Provenex convention, not an OpenTelemetry standard; qualify the source
  mapping and emitter. Synthesized, caller-controlled, or mis-mapped IDs can
  miss the real join or join unrelated events and therefore remain inferred
  evidence.
- **Central availability is currently on the decision path.** The evaluation
  cache is disabled, so every gated action needs a fresh signed judgment. A
  scorer timeout follows the destination's configured fail-open/fail-closed
  posture; it is not a local cache hit.
- **Policy approval is not deployment.** The current browser records
  reviewable suggestions and changes but does not hot-install an approved
  policy. Enforcement claims require deployed configuration and a verified
  digest.
- **The shipped block proof is controlled.** The loopback HTTP mock run proves
  the PEP contract on a controlled upstream. No real customer production
  action has yet been gated.
- **Approval release is not wired.** The policy model can return
  `require_approval`, but the deployed egress proxy has no grant-store/release
  transport. At the current fence it behaves like `deny`; do not market a live
  human-approval release workflow.

## How to read a green verdict

A green verdict means: *no policy fired on the lineage the engine could
reconstruct from the telemetry it received, under the classifications in
force.* Every clause in that sentence is a place reality can differ from
the model. The completeness attestation (spans emitted vs captured), the
`not_covered` discipline, and confidence degradation exist to keep those
clauses measurable instead of implicit.
