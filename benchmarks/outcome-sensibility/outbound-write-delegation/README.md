# Outbound write: a draft-only automation publishes

This repository-authored matched pair models a provider-neutral automation
gateway. Every individual step reports success, including the final write. The
context that does not make sense is the composition: the customer-declared
observed delegation permits a draft, while the action claims publish scope.

| Fixture | Customer-declared observed scope | Attempted scope | Post-action result |
|---|---|---|---|
| [`unsafe_trace.otlp.json`](unsafe_trace.otlp.json) | `draft:outbound` | `publish:outbound` | Red: `delegation-scope-mismatch` |
| [`clean_twin_trace.otlp.json`](clean_twin_trace.otlp.json) | `publish:outbound` | `publish:outbound` | no Red finding on the observed action |

The finding comes from the existing `delegation-scope-mismatch` invariant. It
does not inspect sentiment, decide whether the ordinary product update is good,
or introduce a provider-specific rule. The instruction and message are
intentionally the same in both twins: only the declared scope changes.

## Watch and Protect

`./demos/outbound_write_guardrail.sh` exercises two truthful positions:

- **Watch is post-action.** The production scan reads checked-in synthetic OTLP
  whose tool result already says `accepted`; it can flag the mismatch but
  cannot undo that recorded action.
- **Protect is pre-write.** A separate
  [`protect_intent.otlp.json`](protect_intent.otlp.json) has the same mismatch
  shape but no action completion, provider result, or write id. The local
  production PDP signs a fresh live verdict before the controlled attempt. The
  generic egress PEP verifies it, returns HTTP 403, records a PEP-signed
  enforcement receipt, and adds zero writes to the loopback sink.

The local public demo key is intentionally forgeable and proves mechanism only.
It is not the customer-key/shared-staging proof.

## Normalization examples, not integrations

The provider-neutral `publish_outbound_message` action is the canonical form.
An adapter can normalize provider logs or tool-call names into that form. For
example, `n8n publish post`, `Zapier create social post`, `Make publish post`,
`Buffer publish post`, `Hootsuite publish message`, and `Ayrshare publish post`
all describe an outbound write. These are examples of normalization inputs—not
claims of OAuth connectors, provider partnerships, tested provider APIs, or
live executions. The same boundary also fits AI-BDR sends and meeting-agent
follow-ups when their telemetry carries the required scope context.

Plain provider logs often do not prove who authorized an action. In this
fixture, `provenex.delegation.scope` is customer-declared observed context. It
is not cryptographically authoritative merely because it appears in OTLP. An
enforcement deployment must accept that field only from an authenticated,
configured customer control point; otherwise Provenex should report missing or
untrusted authority evidence instead of claiming a safe action. This local
rehearsal does not implement or prove that production authority adapter; it
proves only how an already-configured scope invariant reaches a signed verdict
and generic enforcement point.

## Reproduce

From a private Provenex source checkout containing this public bundle:

```text
cargo test --test outbound_write_delegation_sandbox
./demos/demo.sh scenario run outbound-write-guardrail
```

[`expected_projection.json`](expected_projection.json) freezes stable fields
from the production CLI. The live regression separately verifies that the
production signer stamps a live-authorizing verdict and the generic PEP turns
it into a block. The demo measures the sink immediately before and after each
attempt: observe adds one write; enforce leaves that count unchanged.

## Claim boundary

All tool names, content, ids, scopes, and results are repository-authored
synthetic telemetry. No n8n, Zapier, Make, Buffer, Hootsuite, Ayrshare, AI-BDR,
meeting-notetaker, or other third-party account/API is contacted. This does not
measure recall, false-positive rate, incident frequency, or provider coverage.
Zero Red findings in the clean observed twin is not proof of absence.
