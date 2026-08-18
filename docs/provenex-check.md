# Provenex Check product contract

Provenex Check is a developer-facing hindsight and guardrails tool for people
shipping software with AI. It is designed first for solo founders and small
teams that can now build and operate real commerce, customer-data, and agentic
systems without a conventional engineering or security organization.

The public CLI is a bounded evidence collector and client. It does not contain,
download, or run the Provenex engine. Free and paid solo-founder runs use a
shared multi-tenant Provenex service. A dedicated or privately deployed engine
is an enterprise deployment option, not part of the public CLI.

## The first useful result

The product must not be another command that merely repeats linter, SAST, or
package-manager output. Its useful unit is a reconstruction across evidence:

- what code and configuration said;
- what AI coding agents read, changed, retried, or failed;
- what was committed, deployed, and observed at runtime;
- which credentials, data, destinations, and privileges were in reach;
- what cloud and model usage cost during the same period; and
- which controls were present, missing, or not evaluated.

The target user resembles the workflow in Lenny's Newsletter's
[account of a solo founder launching a fashion brand with Codex and
ChatGPT](https://www.lennysnewsletter.com/p/how-i-ai-how-a-solo-founder-used):
someone can now launch a commerce business without an engineering team. The
initial report should answer “what would I reasonably want to know before
serving real customers?” in plain language, with evidence and uncertainty
attached.

## Commands

### `provenex-check scan`

`scan` is the bounded first look. With explicit approval, it inventories the
repository, selected AI coding histories, and dependency-audit output. It sends
the approved evidence to the central engine and returns a strict public,
coverage-aware report in an ephemeral self-consistency envelope. The included
verification key is not a Provenex issuer identity or durable attestation. Fly,
CloudWatch, and AWS cost evidence belong to `audit`, so an ordinary `scan`
cannot imply runtime or spend coverage.

Static findings remain useful: exposed credentials, dependency advisories,
unsafe-language surfaces, weak cryptography, missing native/mobile hardening,
and deployment mistakes can all be evidence. They become distinctively useful
when the engine can relate them to agent access, changed files, deployment and
runtime observations, customer-data paths, or spend.

If the user supplies only source, the result is explicitly source-bounded. A
zero-finding source scan never implies that runtime, identity, data, spend, or
agent behavior was evaluated.

Optional local AI-history discovery examines only the first complete JSONL
metadata record for each Claude Code or Codex candidate, with a 64 KiB
per-record bound and 32 MiB aggregate metadata cap. It selects a session only
when that first record's provider-specific `cwd` exactly matches the canonical
scan root. Missing, malformed, or oversized first records are skipped, later
records cannot turn a candidate into a match, and discovered filenames are not
displayed or uploaded. Explicit and discovered inputs share the 256-artifact
and 64 MiB aggregate request bounds; exceeding either remains a fail-closed
error rather than silently omitting sessions.

### `provenex-check audit`

`audit` is a deeper retrospective. It correlates supported agent sessions,
source and dependency state, deploy/runtime telemetry, provider usage and cost
evidence, and separately permissioned connectors. The report groups results
around what nearly shipped, what shipped, what ran, what it cost, what could
leave the system, and what remains unknown. The current alpha uses the
timestamps and bounds present in explicitly supplied evidence; a first-class
`--since` selector is roadmap, not current CLI behavior.

The first implementation may accept explicit files and exports. Automatic
Cloudflare, AWS, Fly, Git host, CI, data-store, or SaaS access is a connector
and must show the exact account, resources, scopes, lookback, retention, and
estimated work before requesting permission.

## Product tiers

This table is the intended product boundary, not a claim that billing,
self-serve signup, recurring connectors, or plan entitlements ship in the
current alpha. The alpha uses manually issued API keys and implements the
bounded `scan` and explicit-export `audit` path only.

| Tier | Product boundary |
|---|---|
| Free Check | Bounded one-off `scan` and introductory retrospective using the shared multi-tenant engine; explicit local files/exports; no continuous background access or enforcement. |
| Solo subscription | Longer history, recurring checks, supported connectors, spend tracking, code/CI gates, agent hooks, and egress policy enforcement. The engine remains server-side. |
| Team | Shared UI, Policy Studio, reusable policy, environments, roles, approvals, evidence retention, and collaboration. |
| Enterprise | Stronger tenancy and data controls, organization-wide connectors and identity, custom retention/regions, SSO, service guarantees, and optional dedicated/private deployment. |

An AI-agent skill or instruction file is advisory context. It can help an agent
choose safer actions, but it is not an enforcement boundary. A claim that an
action was blocked requires evidence from an actual code/CI gate, tool broker,
or egress enforcement point.

## Evidence-safe “aha” claims

The report should create a strong hindsight moment without inventing a
counterfactual:

- Spend: report “$X of attributable spend occurred after this signal was first
  observable,” with dates, included line items, confidence, and exclusions. Do
  not call the entire amount guaranteed savings.
- Exposure: report named findings, reachable or latent attack paths, and the
  evidence that connects them. Do not translate rule counts into “attacks
  prevented” without validated execution or enforcement evidence.
- Regulation: map observed controls and evidence gaps to specific, potentially
  relevant requirements. Do not state that a user violated, passed, or would
  have violated a law without applicability analysis and qualified legal
  review.
- Autonomy: state which actions were observed, allowed, warned, or blocked and
  identify the enforcing component. Do not infer safe autonomy from policy text
  alone.

The EU AI Act is risk- and role-dependent. For example, deployers of applicable
high-risk systems can have monitoring, human-oversight, and log-retention
obligations, while minimal-risk systems do not inherit the same requirements.
Provenex can organize evidence relevant to such controls; it is not a legal
determination. See the European Commission's [Article 26 deployer
obligations](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-26) and
[AI Act FAQ](https://digital-strategy.ec.europa.eu/en/faqs/navigating-ai-act).

## Upload, tenancy, and retention boundary

Before any network request, the CLI must show:

- the exact Provenex API origin;
- each evidence category and its file/record and byte bounds;
- whether source, environment files, sessions, logs, customer-data indicators,
  or cost evidence are included;
- exclusions and known coverage gaps; and
- the applicable processing, retention, and deletion policy.

The user must explicitly approve that preview. Non-interactive execution must
use an explicit consent flag. Credentials are never accepted on the command
line or reproduced in diagnostics.

Authentication determines the tenant; a request cannot select or override a
tenant identifier. The current public Check policy is the versioned
[`provenex-check-ephemeral-v1`](provenex-check-data-policy.md): HTTPS transport,
zero seconds of application-scope retention for raw evidence and derived
results, a request-only workspace that must be deleted before response, and no
request bodies or raw evidence in application logs. A response that omits or
changes that exact policy is rejected. The CLI cannot independently prove
server-side deletion. User-requested local JSON and HTML files are outside the
application policy.

This Check boundary differs from the customer-local Edge described elsewhere
in this repository: Check sends the evidence approved in its preflight to the
central multi-tenant service. Customer-local Edge keeps raw operational
telemetry in the customer's environment and sends only its documented bounded
scoring closure. Neither boundary may be described as the other.

## Public/private boundary

The public repository owns CLI behavior, consent and collection rules, stable
request/response schemas, and report presentation. Proprietary detection,
lineage reconstruction, correlation, model behavior, policy evaluation, and
any future issuer-attestation service remain in the private Provenex engine.
The public package must not bundle an engine binary, depend on a private
repository, or expose private rule rationale, private policy identifiers, model
prompts, or internal confidence machinery. The current response exposes only a
bounded public DTO, an opaque deployment release ID, the exact public data
policy, and an ephemeral signature whose meaning is self-consistency only;
terminal and HTML views are rendered locally.
