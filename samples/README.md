# Synthetic attack-reconstruction appendix

This runner contains 13 repository-authored OTLP reconstructions based on
public disclosures plus a two-trace synthetic delayed-exfil scenario. These 15
fixtures are safe to send to staging as a clearly labeled detection appendix.
They contain no customer telemetry and are not captures from the named vendors.

They do not prove live blocking: `/v1/receipts` evaluates a completed synthetic
trace and persists the result to the selected demo tenant. These fixtures do
not contain evidence from a component that controlled the modeled action.

## Run safely

Use a designated, unexpired demo key. The runner checks authenticated key
health and refuses to start without an explicit central-synthetic
acknowledgment:

```bash
export PROVENEX_DEMO_ENGINE_URL='<Engine origin supplied for this demo tenant>'
export PROVENEX_DEMO_API_TOKEN='pvx_trial_<designated-demo-key>'
export PROVENEX_DEMO_ALLOW_SYNTHETIC_CENTRAL=1
./try-me.sh
```

Do not rename these variables to a general customer credential, add a file
argument, or adapt the script for a customer export. Analyze explicitly
selected customer evidence through the public Check CLI and its consent
preflight.

The script accepts `--no-report` to skip local HTML rendering. Each execution
gets a gitignored `reports/run-<timestamp>-<nonce>/` directory containing the
raw response JSON and headers, the stored-audit response, optional HTML, and
(after every assertion succeeds) a run manifest. Every successful response
must carry the same `X-Provenex-Source-Commit` identity; the manifest records
it, and any value other than a full 40-character commit fails closed. The
runner also fails if the Engine returns the wrong verdict for a scenario's
exact target receipt; incidental Red findings elsewhere in a trace do not
satisfy the assertion.

The checked-in fixtures never change at runtime. The runner isolates each
execution, keeps scenario identities distinct, and rejects a target result
that belongs to another run or scenario.

## Bundle

| # | Fixture | Shape | Expected detection |
|---|---|---|---|
| 01 | EchoLeak / M365 Copilot | untrusted email → privileged retrieval → URL egress | Red |
| 02 | Cursor NomShub | fetched repo rules → credential/device-code egress | multiple Red findings |
| 03 | CurXecute | Slack MCP input → config write → command execution | Red |
| 04 | AgentFlayer | poisoned Drive document → secret search → image URL | Red |
| 05 | ForcedLeak | Web-to-Lead injection → CRM read → partner domain | Red |
| 06 | ShadowLeak | attacker email → mailbox search → server-side POST | Red |
| 07 | Notion PDF exfil | injected PDF → workspace read → search-query egress | Red |
| 08 | CamoLeak | PR comment → private repository → Camo URL | multiple Red findings |
| 09 | CometJacking | untrusted URL parameter → connector data → POST | Red |
| 10 | Anthropic MCP-Git RCE | repository content → MCP argument injection → shell | Red |
| 11 | Delayed exfil, day 0 | poisoned write only | no Red; no egress yet |
| 12 | Delayed exfil, day 2 | later read/egress joined to day 0 | Red, cross-batch lineage |
| 13 | Slack AI exfil | poisoned public-channel retrieval → private-channel secret → unsafe response link → victim click | **known miss**: human click is visible but not a governed agent action |
| 14 | Devin secrets leak | poisoned GitHub issue → runtime secrets → shell/browser egress | multiple Red findings |
| 15 | Bing/Greshake | poisoned adjacent webpage → session history → image fetch | Red |

Traces 11 and 12 run in order with per-run trace, span, and document identities.
The runner verifies that the Day 2 target is connected to the same run's Day 0
write across the modeled persistence boundary. Running either trace alone is
not that proof.

## Related evidence

The public runner covers all 13 named disclosure shapes in this pack, including
Slack AI, Devin's secrets-leak shape, and Bing/Greshake.

Those are disclosure-based telemetry reconstructions, not vendor captures or
proof that a vendor remains vulnerable. AgentDojo is separate benchmark
evidence, not an incident.

The checked-in event timestamps are synthetic scenario times. Several older
fixtures encode the disclosed month/day under a different year; do not use
their OTel timestamps as incident or disclosure chronology. The fixture's
source notes and the linked primary disclosure are the chronology authority.

## What this appendix proves

- The engine recognizes the modeled structural composition across this set of
  curated reconstructions.
- Intent is not required: the same primitive can catch malicious steering and
  honest mistakes.
- Cross-batch detection can join a later egress to an earlier poisoned write.
- The pack also preserves a real boundary instead of forcing every disclosure
  green: Slack AI's disclosed exfiltration completes only when a human clicks
  the generated link, and that click is currently unassessed.

It does not establish production prevalence, customer-specific coverage,
another control's result, an executed exploit, or inline enforcement. A Red
result here is retrospective, not a block receipt. Use Provenex Check against
explicitly approved evidence to evaluate a customer corpus. A live-block claim
requires a result from the component that controlled the same action.

The final stored-audit check is deliberately limited to a low-volume,
dedicated demo tenant: the current endpoint returns at most 1,000 rows and has
no pagination contract. It validates the schema-v2 signer provenance and key
identity returned by the API, but the audit response does not include the
signature envelope needed for local cryptographic verification. Do not present
this runner as an independent signature-verification proof.

## Credential failures

- HTTP 401: the demo key is unknown or revoked.
- HTTP 402: the trial expired even if the key remains unrevoked.
- HTTP 403: the key or tenant is inactive or revoked.
- Missing or invalid scorer public key: stop; the designated staging service is
  not ready.

Renew or reissue the designated demo tenant before the meeting. Never switch
to an unrelated customer's key to make the appendix pass.
