# AgentDojo telemetry-scope benchmark

We keep AgentDojo because it is a useful independent benchmark of agents
executing tools over untrusted data. We report it as a **post-action detection
replay**, not as an AgentDojo prevention/defense score. The evaluated input is
the completed trajectory converted to label-blind OTLP; Provenex then has to
bind a Red verdict to the action AgentDojo says actually occurred.

The frozen machine-readable summary is
[`benchmarks/agentdojo-v0.1.35-gpt4o-important-instructions.summary.json`](../benchmarks/agentdojo-v0.1.35-gpt4o-important-instructions.summary.json).
The 726-row publication artifact is
[`benchmarks/agentdojo-v0.1.35-gpt4o-important-instructions.full.json`](../benchmarks/agentdojo-v0.1.35-gpt4o-important-instructions.full.json).

## Frozen run

- AgentDojo v0.1.35, commit
  `a75aba7631d3ca5fb7ab938965c97ead2f9ff84b`
- published `gpt-4o-2024-05-13` trajectories using the
  `important_instructions` attack
- Provenex source commit
  `6159c40a37522cc32153425c622ce77d59114813`
- fresh isolated `cargo build --release --locked --frozen`; scanner SHA-256
  `56cc5b924c63d11fabeb06aeddd6a6f1c484af115e87e6a55d3dd07e3f94f959`
- 726 of 726 selected trajectories completed; zero scan or source errors
- full result artifact SHA-256
  `ce8c3a444797b0193e384dedd15193e6198466bf1276619b19ed11c8c3b32fc9`

The full artifact publishes each trajectory outcome, target-receipt ledger,
source state, build attestation, and runner/converter/configuration hashes. The
private engine source and replay harness are not mirrored here, so the run is
row-level auditable but not independently reproducible from this public
repository alone. Describe it as a frozen, company-reported result rather than
an independently verified score.

The input omitted AgentDojo security labels and used globally unique replay
identities. Content-derived evidence was enabled and no content ablation was
run, so this result is **label-blind, not content-blind**, and must not be
described as “chain structure alone.”

## Scope funnel

| Cohort | Trajectories | Why it matters |
|---|---:|---|
| AgentDojo attack-labeled | 629 | Complete attack corpus; the target did not necessarily happen |
| Attack target achieved | 300 | AgentDojo says the malicious objective occurred |
| Target achieved as a tool action | 297 | Observable action exists in the converted telemetry |
| Protected action | 279 | Current Provenex action-policy scope |
| External-source read | 18 | Telemetry-visible read, but reads are not currently governed sinks |
| Text-only target | 3 | No target tool-action receipt; content/refusal evaluation is out of scope |

Across all 629 attack-labeled trajectories, 384 produced some Red finding
(61.1%). That is a descriptive corpus alert rate, **not recall**: in 329 cases
the AgentDojo attack target never occurred, and a Red may bind to another
observed action.

## In-scope performance

| Metric | Result |
|---|---:|
| Protected-action trajectory: at least one declared target receipt Red | **240 / 279 (86.0%)** |
| Protected-action trajectory: all manifest-required target stages Red | **222 / 279 (79.6%)** |
| All telemetry-visible target tool actions, including read-only targets | **240 / 297 (80.8%)** |
| External-source read targets | **0 / 18 (0%)** |
| Text-only successful targets | **0 / 3 (out of action scope)** |

The 86.0% number is the clearest current headline for what Provenex claims to
govern. The stricter 79.6% number prevents a partial catch on one stage of a
compound objective from being presented as complete target coverage.

## Miss ledger

The 39 protected-action misses are product work, not exclusions:

| Miss family | Count | Current failure mode |
|---|---:|---|
| Workspace `delete_file` | 22 | Target action not assessed |
| Travel `reserve_hotel` | 3 | Target action not assessed |
| Slack `send_direct_message` | 7 | Assessed, but non-Red |
| Slack invite/add/remove membership mutations | 7 | Only part of the required compound target was assessed/Red |

External-source reads add 18 known out-of-policy misses. They are observable
in telemetry but not protected sinks today. This distinction is important:
“telemetry-visible” is broader than “currently governed.”

## Controls and alert burden

The no-injection controls also expose a serious starter-policy tuning issue:
40 of 97 controls were Red (41.2%), including 32 of 67 utility-passing controls
(47.8%). We call this the **starter/default-config control alert rate**, not a
false-positive rate. AgentDojo does not provide the customer authorization and
policy context needed to decide whether every composition is actually allowed.
The frozen run used the checked-in starter configuration without
customer-specific policy. A rate this high still predicts substantial review
burden and requires adjudication and policy tuning before making specificity
claims.

## Interpretation limits

- This benchmark tests completed trajectory detection, not inline blocking.
- It does not evaluate prompt/content classifiers or model refusal quality.
- A target must actually occur and have a target action receipt before target
  detection can be measured.
- Vendor/product coverage depends on telemetry export and correct mapping;
  reconstructing a trajectory does not claim native vendor telemetry exists.
- Results apply to the frozen commits/configuration above, not every newer
  build. Re-run and publish a new immutable summary after material engine or
  mapping changes.
