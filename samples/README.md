# Provenex trial — sample telemetry

After you sign up at https://provenex.ai/trial and get your API key by email, drop into this directory and run:

```bash
PROVENEX_API_KEY=pvx_trial_xxxxxxxxxxxxxxxxxxxxxxxxxxxx ./try-me.sh
```

The script posts 7 curated OTLP/JSON traces to your trial endpoint and shows exactly what Provenex fires on each. Takes about 10 seconds end-to-end.

## What's in the bundle

| # | File | Class | Expected verdict |
|---|---|---|---|
| 1 | `01_echoleak_breach.otlp.json` | Public breach (M365 Copilot) | **Red** `cross-zone-composition` — EchoLeak CVE-2025-32711 reconstruction |
| 2 | `02_devin_secrets_leak.otlp.json` | Public breach (coding agent) | **≥2 Red** `cross-zone-composition` — Devin secrets leak; multi-egress shape |
| 3 | `03_slack_ai_exfil.otlp.json` | Public breach (Slack AI) | **≥2 Red** `cross-zone-composition` — PromptArmor disclosure; channel poisoning |
| 4 | `04_bing_greshake.otlp.json` | Public breach (Bing chat) | **Red** `cross-zone-composition` — earliest documented indirect prompt injection (2023) |
| 5 | `05_cursor_nomshub.otlp.json` | Public breach (coding agent supply chain) | **≥2 Red** `cross-zone-composition` — Straiker AI disclosure; malicious .cursorrules |
| 6 | `06_delayed_exfil_day0_write.otlp.json` | Patient attacker — poisoning | **0 Red** — write-only; nothing leaves yet (this is the setup step) |
| 7 | `07_delayed_exfil_day2_egress.otlp.json` | Patient attacker — exfil two days later | **Red** `high-risk-resource-egress` — cross-batch closure walks back to the Day 0 write |

## What you should see in your inbox / audit log

After running the script, your tenant audit log holds **8+ Red verdicts** across all 7 traces (some traces have multiple egress points). Retrieve them:

```bash
curl -H "Authorization: Bearer $PROVENEX_API_KEY" \
  https://api.provenex.ai/v1/verdicts?limit=20 | python3 -m json.tool
```

Each verdict includes:
- The full **ed25519-signed artifact** (verifiable against the public key — Phase 2 publishes the verifier)
- The **closure** (which spans on the lineage walked back from the egress)
- The **binding reason** (the policy that fired)
- **Risk / verdict / confidence** axes

## Running individual scenarios

The script posts all 7 in sequence; if you want to poke individual ones:

```bash
curl -X POST https://api.provenex.ai/v1/receipts \
  -H "Authorization: Bearer $PROVENEX_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @01_echoleak_breach.otlp.json
```

## What this proves

- Traces 1–5 are reconstructions of **every published production AI-agent breach in the 2024–2025 disclosure literature** that fits the cross-zone-composition shape. Provenex catches all five end-to-end with zero customer configuration — no `trust_zones.yaml` written, no per-vendor tuning.
- The catch is **intent-blind by primitive**. The engine asks only whether a privileged action descended from a source not verified for it; it never asks whether the upstream content was malicious. The honest-mistake archetypes (production change from non-production source, cross-tenant outbound, IAM widen from external vendor request, etc.) ship as separate fixtures in [`fixtures/honest_mistake/`](../fixtures/honest_mistake/) and fire on the same primitive. They aren't in this trial bundle yet because they use synthetic SaaS URIs the trial heuristic catalog doesn't classify — production customers running the trial against their own real traffic will see them fire naturally as long as the URIs match real SaaS-AI / OTel-GenAI patterns. See [docs/onboarding-trial.md](../docs/onboarding-trial.md) for what telemetry produces the strongest catch surface.
- Traces 6 → 7 demonstrate **cross-batch lineage** — the patient-attacker shape. Day 0 the poisoned write lands; Day 2 (a separate request, hours later) the egress fires because the closure walks back to the Day 0 receipt via the shared resource fingerprint. No per-session evaluator can see this.

## Trying it with your own telemetry

These bundled traces are reconstructions + synthetic-but-realistic fixtures we author. The point is to give you something to compare against on day 1. To run on **your real traces**:

1. Wire your OpenTelemetry Collector to also export to `https://api.provenex.ai/v1/traces` (the OTLP/HTTP-standard path) with `Authorization: Bearer $PROVENEX_API_KEY`.
2. Generate normal agent traffic.
3. Poll `https://api.provenex.ai/v1/verdicts` for what fired.

Full onboarding walkthrough: [docs/onboarding-trial.md](../docs/onboarding-trial.md). Telemetry checklist to make sure your traces have what we need: [docs/telemetry-checklist.md](../docs/telemetry-checklist.md).

## Hash-only mode (privacy preserving)

The bundled traces have plaintext prompts + tool I/O so you can see exactly what the engine reads. In production, run [`provenex-ingest-proxy`](../docs/ingest-proxy.md) in `--mode=hash` and content fields are HMAC-SHA-256 hashed under your per-tenant salt before they reach us. Resource URIs pass through (drive zone classification); customer data does not.

## What the trial limits look like

| | |
|---|---|
| Trial duration | 30 days from signup |
| Body limit per request | 16 MiB |
| Verdict retention | 30 days |
| Cross-batch lineage window | 5,000 most-recent receipts per tenant |
| Rate limit | 100 req/min per tenant (soft) |

After day 30 the API key returns HTTP 402. Your historical verdicts stay queryable for another 30 days; no data loss on conversion.
