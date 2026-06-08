# Telemetry checklist — what to emit for best results

A short, actionable checklist for customers integrating Provenex. Tiered by how much catching power each piece unlocks. Most customers using a modern agent framework (LangChain, LlamaIndex, OpenAI Assistants, Anthropic SDK, LangGraph, Mastra) emit enough of this **by default** to get full value — but the checklist makes it explicit so security teams can verify before running an eval.

## TL;DR — minimum viable telemetry

If you can answer **yes** to these three, you're ready to send Provenex your telemetry and see real Red verdicts:

- [ ] Your agent emits OpenTelemetry traces (any of the listed shapes below)
- [ ] Each span carries `trace_id` and `span_id`
- [ ] The chain of `parent_span_id` from the agent's output back to its inputs is reconstructable

Almost any modern agent framework with OpenTelemetry instrumentation passes this bar. **If you're not sure, just send us a sample trace — we'll run it through `provenex-scan` and tell you what's in it.**

---

## What we need, in order of importance

### Tier 0 — Required (engine can't ingest at all without these)

| Attribute | Why we need it | What happens if missing |
|---|---|---|
| `trace_id` | Basic OTel span identity | Span ignored entirely |
| `span_id` | Same | Same |

Every OTLP exporter emits these by default. If you're not emitting them, your collector pipeline is broken upstream of Provenex.

### Tier 1 — Strongly required (span typing — the engine reads ONE of these)

The most reliable way for Provenex to know what a span IS (tool call vs chat vs retrieval vs agent invocation). Emit **one** of these on every relevant span:

| Telemetry shape | Attribute the engine reads natively |
|---|---|
| OTel-GenAI (canonical) | `gen_ai.operation.name` ∈ {`chat`, `execute_tool`, `retrieval`, `invoke_agent`, ...} |
| OpenInference / Phoenix | `openinference.span.kind` ∈ {`LLM`, `TOOL`, `RETRIEVER`, `AGENT`, `CHAIN`, `EMBEDDING`} |
| LangSmith | `langsmith.span.kind` |
| LangFuse | `langfuse.observation.type` |
| OpenLLMetry / Traceloop | `traceloop.span.kind` |
| Vercel AI SDK / Mastra | Span name patterns (`ai.toolCall`, `ai.streamText`, `ai.generateText`, `ai.embed`) — auto-normalized |
| mcp-agent Python SDK | Auto-normalized to canonical tool URI shapes |
| Datadog dd-trace-py | `_dd.llmobs.span_kind` — needs a converter step (`tools/blind_corpus/convert_dd_to_otlp.py`) |
| AWS Bedrock InvokeAgent | TracePart structure — needs a converter step |

If your SDK already emits one of these, you're done — no manual instrumentation needed. **If you're using LangChain / LlamaIndex / LangGraph and your collector is configured to OTLP, this is automatic.**

#### Don't have any of these?

Provenex still tries to type spans via attribute-based fallback:

- `url.full` / `http.url` → typed as the URL resource directly (egress spans get caught this way)
- `gen_ai.agent.name` → `agent://<name>`
- `gen_ai.tool.name` → `tool://<name>`
- Heuristic fingerprinting for retrieval-shaped spans

Fallback degrades catch confidence from `Confirmed` to `Inferred`, but **does not** make the engine non-functional. **The only true failure is when ≥80% of spans fall through to `span://<hex>` with no kind attribute** — at that point we tell you "the customer needs an adapter" with a specific error and don't pretend to evaluate.

### Tier 2 — Strongly recommended (closes catch confidence + cross-batch)

Each of these unlocks a specific catch class. Order matters; first ones first.

| Attribute | Catch class it unlocks |
|---|---|
| `parent_span_id` (clean OTel parent chains) | **Closure walker can resolve in-trace lineage in one pass**. Without it the engine falls back to 4 recovery mechanisms — still works but slower + degrades confidence. |
| `gen_ai.tool.name` | Tool-name catalog classification (e.g. `tool://send_email` → external-egress, `tool://lookup_customer` → privileged-pii). Without it, classification falls to span-name heuristics. |
| `gen_ai.tool.call.arguments`, `.result` | **Payload-token cross-receipt linking** — same identifier appearing in two agents' tool args creates an `AsyncLink` edge, catches cross-agent async handoff (Salesforce Agentforce / M365 Copilot / n8n workflow apps). |
| `gen_ai.data_source.id` | Source identity propagation — used for both zone classification and **cross-batch document.id rejoin** (delayed-exfil patterns, patient-attacker shape). |
| `enduser.id` (or `user.id` / `gen_ai.user.id`) | **Actor identity** for Phase B risk accumulation across sessions. Required for cross-agent sticky-risk propagation. Phase D (cross-agent fan-out catching the "Alice's ChatGPT activity elevates her in-house agent") needs this. |
| `gen_ai.agent.name` | Agent topology — drives latent-attack-path BFS. Without it, the latent path enumerator can still surface topology, but agent attribution is `agent://<service.name>`. |
| `service.name` | Multi-service deployments — disambiguates two agents under the same `agent.name`. |

### Tier 3 — High-fidelity signals (vendor-specific; pass through automatically)

If your stack carries these, the engine surfaces them as first-class signals. None are required, but each one lights up specific catches when present:

| Attribute | Source | What it does |
|---|---|---|
| `provenex.copilot.xpia_detected` | M365 Copilot UAL | EchoLeak (CVE-2025-32711) signature — the high-fidelity post-fix flag |
| `provenex.copilot.jailbreak_detected` | M365 Copilot UAL | Jailbreak classifier signal |
| `provenex.copilot.bing_grounding` | M365 Copilot UAL | Marks Bing-web-grounded interactions |
| `bedrock.guardrail.action = INTERVENED` | AWS Bedrock | Bedrock Guardrails caught content |
| `provenex.chatgpt.identity_synthetic` | ChatGPT Enterprise audit | Marks synthesized vs. real user identity (service accounts vs. real humans) |
| `provenex.delegation.scope` | Multi-agent delegation | Delegation-scope mismatch policy |
| `provenex.document.id` | Cross-batch correlation | Same document id across batches = cross-time lineage edge |
| `provenex.crossbatch.origin` | Auto-stamped by engine | (Engine produces this — don't emit it yourself.) |

---

## Pre-flight check before evaluation

Before pointing your traces at Provenex's trial endpoint, sanity-check your telemetry shape:

```bash
# Pipe a sample OTLP/JSON file from your collector to scan locally
curl https://provenex.ai/static/preflight.sh | bash -s your-trace.otlp.json
# (Phase 2 — script is the wrapper around `provenex-scan` that produces
#  the Step-0 qualification report without sending anything to us.)
```

Or just send the file and inspect the response:

```bash
curl -X POST https://api.provenex.ai/v1/receipts \
  -H "Authorization: Bearer pvx_trial_xxx" \
  -H "Content-Type: application/json" \
  --data-binary @your-trace.otlp.json
```

The response carries `receipts_ingested` (egress points evaluated) and `red_verdicts`. If `receipts_ingested` is 0:

- Your trace has no egress-shaped spans — Provenex needs at least one `execute_tool` or `http`-shaped destination span to evaluate against. Confirm your collector is exporting tool / HTTP spans, not just LLM chat spans.

If `receipts_ingested > 0` but `red_verdicts = 0`:

- Either your traces are genuinely clean (good!) or upstream lineage is broken. Check `parent_span_id` chains via your APM. The 4 lineage-recovery mechanisms handle most broken-chain cases but they degrade confidence from `Confirmed` to `Inferred`.

---

## What we DON'T need

- **Prompt content for catches.** Provenex evaluates structural composition; content is hashed if you're running the open-source `provenex-ingest-proxy` in hash mode, and not used for catching either way. Sending prompts is fine for trial-launch (we don't read them); the hash-only mode is for security-team-mandated zero-content-leaving environments.
- **Custom instrumentation.** If your existing OpenTelemetry / framework instrumentation isn't enough, the gap is usually a missing OTLP exporter on your collector, not a Provenex requirement.
- **A trust_zones.yaml at signup.** The engine auto-classifies via the heuristic discovery overlay. You can author one later to tune classifications; the trial works without it.

---

## What unlocks specific catches

If you want a particular catch class to fire, here's the minimum:

| Catch | Minimum telemetry |
|---|---|
| **Cross-zone composition** (the headline catch — every published breach) | Tier 0 + Tier 1 + a clean `parent_span_id` chain OR the 4 fallback recovery mechanisms |
| **Latent attack path enumeration** (the day-1 onboarding finding) | Tier 0 + Tier 1 + multiple tool spans per agent |
| **Delayed exfil** (patient-attacker — write Monday, exfil Friday) | Above + `gen_ai.data_source.id` AND/OR `provenex.document.id` |
| **Cross-agent risk propagation** (Phase D — Alice's ChatGPT elevates her in-house agent) | Above + `enduser.id` consistent across sources |
| **Trust-zone drift** (vendor changes its tool catalog under you) | Above + customer signs off on `trust_zones.yaml` (we snapshot at first observation) |
| **Honest-mistake archetypes** (intent-blind — non-prod to prod, cross-tenant, etc.) | Above + customer-side attributes that mark provenance (`provenex.source.scope`, `provenex.source.tenant`, etc. — emit at instrumentation time) |
| **EchoLeak XPIA signature** (CVE-2025-32711) | M365 Copilot UAL ingestion (we emit `provenex.copilot.xpia_detected`) |

---

## Framework cheat sheet

Common frameworks and their out-of-box telemetry shape — useful for confirming where your collector should look.

| Framework | Default shape | Default OTel-GenAI compatible? |
|---|---|---|
| LangChain (with `opentelemetry-instrumentation-langchain` or LangSmith→OTLP) | OpenInference + custom langchain spans | Yes |
| LlamaIndex (with `llama-index-instrumentation-otel`) | OpenInference | Yes |
| LangGraph | OpenInference + langgraph metadata | Yes |
| OpenAI Assistants (with `openai-instrumentation`) | OpenInference | Yes |
| Anthropic SDK direct | Manual + `anthropic-instrumentation` (community) | Partial — depends on collector config |
| Vercel AI SDK / Mastra | Vendor span names (`ai.toolCall`, etc.) — auto-normalized | Yes (auto-normalization landed) |
| smolagents | OpenInference | Yes |
| Mastra | Vendor span names — auto-normalized | Yes |
| AWS Bedrock Agents | TracePart structure | Needs converter (auto-converted by ingestor) |
| Azure OpenAI / Microsoft Copilot Studio | Application Insights → OTel exporter | Yes |
| Datadog LLM Observability (dd-trace) | `_dd.llmobs.*` | Needs converter |
| LangFuse / Phoenix | Native (OpenInference under the hood) | Yes |

If your framework isn't listed, **send us a sample trace** — we'll tell you what's in it and what's missing.

---

## Common gotchas

1. **`gen_ai.input.messages` and `gen_ai.output.messages` carry JSON-stringified arrays, not flat strings.** Both shapes work but the JSON shape is what enables payload-token extraction (cross-agent linking). Modern instrumentation emits JSON.
2. **`parent_span_id` is empty on root spans** — that's expected (every trace has one root). The engine handles roots correctly; the recovery mechanisms only engage when an intermediate span has missing/broken parent links.
3. **LangChain → OpenAI SDK does NOT propagate context cleanly** — the chat span looks like a sibling, not a child, of the agent invocation. Provenex's cross-emitter LLM stitcher handles this; you don't need to fix it client-side.
4. **Sampling will break you.** If your collector is configured to sample 10% of traces, Provenex sees a 10% subset and the closure walker can miss the cross-batch hops. Provenex is the consumer that needs **100% sampling**. If you can't do 100% globally, configure your sampler to send 100% of GenAI traces.
5. **Sensitive content in resource URIs.** If your `gen_ai.data_source.id` is `outlook://mailbox/alice@acme.com/inbox/...`, then "Alice's email" reaches Provenex inside the resource URI. The hash-only mode redacts content fields but NOT resource URIs (because those drive classification). Either (a) hash the local-part client-side before instrumentation, or (b) configure `provenex-ingest-proxy` Phase 2 redaction patterns when they ship.

---

## We will tell you if something's off

Every Provenex scan emits a **Step-0 qualification verdict** that names what the engine could and couldn't evaluate:

- `Evaluable` — telemetry has the shape the engine can walk; full catch surface eligible
- `PartialEvaluable` — spans parsed but resources unresolved; **needs an adapter or a missing kind attribute**
- `BareLlm` — no structural shape to evaluate (just chat spans, no tools); per-prompt classifiers are the right tool here
- `NotEvaluableAdapterEmpty` — zero receipts produced; check that the body is OTLP JSON
- `NotEvaluableAdapterMissing` — ≥80% of receipts fell to `span://<hex>` synthetic IDs; tell us your framework

These appear in `/v1/receipts` responses (Phase 2 — full surface in the dashboard); for now, use `provenex-scan` against a sample file locally to get the full readout before integration.

---

## Quick links

- [Onboarding guide](onboarding-trial.md)
- [Open-source ingest proxy (hash mode)](ingest-proxy.md)
- [What the engine catches and why](how-provenex-catches.md)
- [The full architectural reference](../README.md) (§"What telemetry Provenex expects")
