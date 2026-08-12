# Honest-mistake archetype fixtures

Five archetypes, each with a matched unsafe + benign-twin OTel-GenAI trace pair, demonstrating Provenex's chain-level catch on synthetic-but-realistic telemetry. **No attacker. No injection. No malicious content.** The fixtures model steps that are individually valid and authorized; they do not contain decision artifacts from incumbent controls. The unsafe outcome lives in the composition across steps.

| Archetype | Industry | Customer invariant |
|---|---|---|
| [A1](a1_nonprod_to_prod/) | Any company running infrastructure | No production change may descend from a non-production-scoped source |
| [A2](a2_cross_tenant/) | Multi-tenant SaaS, B2B | No egress to a tenant may descend from another tenant's data |
| [A3](a3_iam_widen/) | Cloud-native, large enterprise | No production access-control change may descend from an external, unverified-for-this-scope origin |
| [A4](a4_ledger_post/) | Fintech, banking, insurance | No ledger-posting action may descend from an upstream input that lacks a verified-source attestation |
| [A5](a5_superseded_policy/) | Healthcare, legal, regulated industries | No action may descend from a source marked superseded when a current version exists |

## Frozen validation

These exact files were re-run on 2026-08-12 against Provenex source commit
`f2487f23889cc7cee2074e6ed74468f1464a4b66`: all five unsafe fixtures
returned Red with the declared chain-level binding and all five benign twins
returned zero Red (10/10 regression assertions passed). The machine-readable
file hashes and outcomes are in [`summary.json`](summary.json).

This is a policy-scoped test: it uses [`policies.yaml`](policies.yaml) and the
per-archetype trust-zone file. It is not a zero-config result or a claim that
every customer would classify these resources identically.

## Per-archetype layout

Each directory ships four artifacts:

```
<archetype>/
├── reconstructed_trace.otlp.json   # the UNSAFE trace — expected offline result: Red
├── benign_twin_trace.otlp.json     # the BENIGN TWIN — same shape, clean origin property — expected: zero Red
├── customer_trust_zones.yaml       # zone classification representing the customer's chain-level invariant
└── contrast_panel.md               # structural comparison; incumbent outcomes are not measured by the fixture
```

## What these fixtures prove and what they don't

**They prove:** the chain Provenex reconstructs is correct, the verdict on the unsafe trace fires on the chain-level invariant (not on surface features), and the benign twin clears (so the engine distinguishes the tested structural difference).

**They do not prove:** how often these chains occur in a real enterprise, or whether a named incumbent control would allow, detect, or block the exact transaction. The contrast panels describe structural control boundaries to validate in a customer environment; they are not recorded incumbent verdicts. Frequency and comparative-control evidence require a design-partner deployment with correlated telemetry and decision artifacts.

## Reproduction boundary

This public repository contains the exact fixture/configuration corpus and
hashes, but not the Provenex engine source or regression harness. Engine
operators can reproduce the recorded assertion with
`cargo test --test honest_mistake_traces` at the frozen source commit. Public
readers can audit the matched structural differences and verify every file
hash from `summary.json`; they cannot independently execute Provenex from this
repository alone.

## Honesty boundary

These demos run on synthetic-but-realistic telemetry that Provenex authors. They are an **existence proof of the Provenex mechanism**, not evidence of real-world frequency or an incumbent miss. Each demo legitimately shows that the chain is reconstructible, the configured Provenex invariant fires on the unsafe trace, and the matched benign twin clears. State that boundary plainly when presenting. **The fixture supports the evaluation; correlated customer evidence supports the comparative claim.**

## Relationship to IFC literature

These archetypes demonstrate that Provenex's configured catch surface can be
**intent-blind**. IFC work is commonly evaluated against malicious
prompt-injection settings, where "untrust" is treated as attacker-controlled.
The honest-mistake fixtures exercise a different source
condition—legitimate-but-wrong provenance—without claiming a head-to-head
result against another system.
