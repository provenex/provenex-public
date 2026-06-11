# Provenex trial: sample telemetry

After you sign up at https://provenex.ai/trial and get your API key by email, drop into this directory and run:

```bash
PROVENEX_API_KEY=pvx_trial_xxxxxxxxxxxxxxxxxxxxxxxxxxxx ./try-me.sh
```

The script posts 12 curated OTLP/JSON traces to your trial endpoint and shows what Provenex fires on each. Takes about 15 seconds end-to-end.

## What's in the bundle

Every named production AI-agent breach disclosed through January 2026 that fits the cross-zone-composition shape, plus a two-trace patient-attacker scenario showing cross-batch lineage.

| # | File | Disclosed | Vendor | Expected verdict |
|---|---|---|---|---|
| 01 | `01_echoleak_breach.otlp.json` | 2025-06 | M365 Copilot | **Red** `cross-zone-composition`. CVE-2025-32711; XPIA via marketing-newsletter email; Teams URL preview exfil |
| 02 | `02_cursor_nomshub.otlp.json` | 2025-06 | Cursor + .cursorrules | **≥2 Red** `cross-zone-composition`. Straiker AI disclosure; malicious rules file from public repo |
| 03 | `03_curxecute_cursor_mcp.otlp.json` | 2025-07 | Cursor + Slack MCP | **Red** `cross-zone-composition`. CVE-2025-54135 (CVSS 8.6); Slack message rewrites `~/.cursor/mcp.json` and auto-execs |
| 04 | `04_agentflayer_chatgpt_connectors.otlp.json` | 2025-08 | ChatGPT + Google Drive Connector | **Red** `cross-zone-composition`. Zenity Labs Black Hat 2025; poisoned Drive doc fires zero-click |
| 05 | `05_forcedleak_salesforce_agentforce.otlp.json` | 2025-09 | Salesforce Agentforce + Einstein | **Red** `cross-zone-composition`. Noma Labs CVSS 9.4; Web-to-Lead injection exfils CRM via expired CSP-allowed domain |
| 06 | `06_shadowleak_chatgpt_deep_research.otlp.json` | 2025-09 | ChatGPT Deep Research + Gmail | **Red** `cross-zone-composition`. Radware disclosure; server-side mailbox exfil, no client image |
| 07 | `07_notion3_pdf_exfil.otlp.json` | 2025-09 | Notion AI 3.0 | **Red** `cross-zone-composition`. CodeIntegrity; PDF white-on-white inject; exfil via web-search query |
| 08 | `08_camoleak_github_copilot.otlp.json` | 2025-10 | GitHub Copilot Chat | **≥2 Red** `cross-zone-composition`. CVE-2025-59145 (CVSS 9.6); PR comment exfils private repo via Camo image URL sequence |
| 09 | `09_cometjacking_perplexity.otlp.json` | 2025-10 | Perplexity Comet | **Red** `cross-zone-composition`. LayerX disclosure; URL `?collection=` param fires connector exfil to attacker POST |
| 10 | `10_anthropic_mcp_git_rce.otlp.json` | 2026-01 | Claude + mcp-server-git | **Red** `cross-zone-composition`. CVE-2025-68143/4/5; repo README drives git-MCP tool injection chain to RCE |
| 11 | `11_delayed_exfil_day0_write.otlp.json` | (synthetic) | Patient-attacker setup | **0 Red**. Write-only Day 0; nothing leaves yet |
| 12 | `12_delayed_exfil_day2_egress.otlp.json` | (synthetic) | Patient-attacker exfil | **Red** `high-risk-resource-egress`. Day 2 closure walks back across batches to the Day 0 write |

## What you should see in your inbox / audit log

After running the script, your tenant audit log holds **12+ Red verdicts** across the 12 traces (some have multiple egress points). Retrieve them:

```bash
curl -H "Authorization: Bearer $PROVENEX_API_KEY" \
  https://api.provenex.ai/v1/verdicts?limit=20 | python3 -m json.tool
```

Each verdict includes:
- The full **ed25519-signed artifact** (verifiable against the public key; a standalone published verifier is on the roadmap)
- The **closure** (which spans on the lineage walked back from the egress)
- The **binding reason** (the policy that fired)
- **Risk / verdict / confidence** axes

### Render a verdict as a self-contained HTML report

If you're running `provenex-ingest send` or `batch`, add `--report verdict.html` to write a single-file HTML summary alongside the JSON. Opens in any browser, sharable in Slack / email / a ticket:

```bash
provenex-ingest send 01_echoleak_breach.otlp.json \
  --api-key $PROVENEX_API_KEY \
  --report verdict-echoleak.html
open verdict-echoleak.html
```

The report shows the closure chain as a graph, the binding reason in plain English, the source classifications, and the exact spans Provenex walked back from the egress.

## Running individual scenarios

The script posts all 12 in sequence; if you want to poke individual ones:

```bash
curl -X POST https://api.provenex.ai/v1/receipts \
  -H "Authorization: Bearer $PROVENEX_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @01_echoleak_breach.otlp.json
```

## What this proves

- Traces 01-10 are reconstructions of **every named production AI-agent breach disclosed through January 2026** that fits the cross-zone-composition shape. Provenex catches all of them end-to-end with zero customer configuration; no `trust_zones.yaml` written, no per-vendor tuning. The bundle is updated as new disclosures land; if you see a recent one missing, write trials@provenex.ai and we'll add it.
- The catch is **intent-blind by primitive**. The engine asks only whether a privileged action descended from a source not verified for it; it never asks whether the upstream content was malicious. The honest-mistake archetypes (production change from non-production source, cross-tenant outbound, IAM widen from external vendor request, etc.) ship as separate fixtures in [`fixtures/honest_mistake/`](../fixtures/honest_mistake/) and fire on the same primitive. They aren't in this trial bundle yet because they use synthetic SaaS URIs the trial heuristic catalog doesn't classify; production customers running the trial against their own real traffic see them fire naturally as long as the URIs match real SaaS-AI / OTel-GenAI patterns. See [docs/onboarding-trial.md](../docs/onboarding-trial.md) for what telemetry produces the strongest catch surface.
- Traces 11 → 12 demonstrate **cross-batch lineage** (the patient-attacker shape). Day 0 the poisoned write lands; Day 2 (a separate request, hours later) the egress fires because the closure walks back to the Day 0 receipt via the shared resource fingerprint. No per-session evaluator can see this.

## Trying it with your own telemetry

These bundled traces are reconstructions + synthetic-but-realistic fixtures we author. The point is to give you something to compare against on day 1. To run on **your real traces**:

1. Wire your OpenTelemetry Collector to also export to `https://api.provenex.ai/v1/traces` (the OTLP/HTTP-standard path) with `Authorization: Bearer $PROVENEX_API_KEY`.
2. Generate normal agent traffic.
3. Poll `https://api.provenex.ai/v1/verdicts` for what fired.

Full onboarding walkthrough: [docs/onboarding-trial.md](../docs/onboarding-trial.md). Telemetry checklist to make sure your traces have what we need: [docs/telemetry-checklist.md](../docs/telemetry-checklist.md).

## Hash-only mode (privacy preserving)

The bundled traces have plaintext prompts + tool I/O so you can see exactly what the engine reads. In production, run [`provenex-ingest`](../docs/install.md) in `--mode=hash` and content fields are HMAC-SHA-256 hashed under your per-tenant salt before they reach us. Resource URIs pass through (drive zone classification); customer data does not.

## What the trial limits look like

| | |
|---|---|
| Trial duration | 30 days from signup |
| Body limit per request | 16 MiB |
| Verdict retention | 30 days |
| Cross-batch lineage window | 5,000 most-recent receipts per tenant |
| Rate limit | 100 req/min per tenant (soft) |

After day 30 the API key returns HTTP 402. Your historical verdicts stay queryable for another 30 days; no data loss on conversion.
