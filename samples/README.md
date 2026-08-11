# Synthetic attack-reconstruction appendix

This runner contains ten repository-authored OTLP reconstructions based on
public disclosures plus a two-trace synthetic delayed-exfil scenario. These 12
fixtures are safe to send to staging as a clearly labeled detection appendix.
They contain no customer telemetry and are not captures from the named vendors.

They do **not** prove live blocking: `/v1/receipts` evaluates a completed
synthetic trace and persists the result to the selected demo tenant. The
trusted live-block proof is the customer-local Install Edge rehearsal, where
the reverse proxy forwards in observe mode and returns HTTP 403 without
upstream delivery in enforce mode.

## Run safely

Use a designated, unexpired demo key. The runner checks authenticated key
health and refuses to start without an explicit central-synthetic
acknowledgment:

```bash
export PROVENEX_DEMO_ENGINE_URL='https://provenex-verdict.fly.dev'
export PROVENEX_DEMO_API_TOKEN='pvx_trial_<designated-demo-key>'
export PROVENEX_DEMO_ALLOW_SYNTHETIC_CENTRAL=1
./try-me.sh
```

Do not rename these variables to a general customer ingest credential, add a
file argument, or adapt the script for a customer export. Actual telemetry must
be imported into the customer-local edge/UI.

The script accepts `--no-report` to skip local HTML rendering. JSON and HTML
artifacts go under the gitignored `reports/` directory by default.

## Bundle

| # | Fixture | Shape | Expected detection |
|---|---|---|---|
| 01 | EchoLeak / M365 Copilot | untrusted email → privileged retrieval → URL egress | Red, cross-zone composition |
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

Traces 11 and 12 must run in order against the same demo tenant to demonstrate
the cross-batch join. Running either trace alone is not that proof.

## Related engine evidence

The default runner stays focused on the current ten-case disclosure pack. A
separate older engine regression suite also covers Slack AI, Devin's
secrets-leak shape, and Bing-Greshake, along with EchoLeak and Cursor NomShub.
After removing those two overlaps, the suites cover 13 unique named public
shapes.

Those are disclosure-based telemetry reconstructions, not vendor captures or
proof that a vendor remains vulnerable. AgentDojo is separate benchmark
evidence, not an incident, and the engine's 18 latent-path playbooks are
discovery hypotheses, not 18 additional breach samples.

## What this appendix proves

- The engine recognizes the modeled structural composition across this set of
  curated reconstructions.
- Intent is not required: the same primitive can catch malicious steering and
  honest mistakes.
- Cross-batch detection can join a later egress to an earlier poisoned write.

It does not establish production prevalence, customer-specific coverage,
another control's result, an executed exploit, or inline enforcement. A Red
result here is a retrospective policy finding, not a block receipt. Use
Discovery against approved customer-local telemetry to establish topology and
coverage, and use the reverse-proxy safe rehearsal for the live-block claim.

## Credential failures

- HTTP 401: the demo key is unknown or revoked.
- HTTP 402: the trial expired even if the key remains unrevoked.
- HTTP 403: the key or tenant is inactive or revoked.
- Missing/invalid scorer public key: stop; the expected ADR-008-capable staging
  service is not ready.

Renew or reissue the designated demo tenant before the meeting. Never switch
to an unrelated customer's key to make the appendix pass.
