# Provenex trial — onboarding guide

Get from "I want to try this" to "I see real Red verdicts on my agent telemetry" in about 10 minutes.

## What you get

A hosted Provenex trial. Your AI agent telemetry → Provenex's verdict engine → ranked Red verdicts you can retrieve over HTTPS or pipe into your SIEM. **30-day free trial**, no credit card required, no data leaves your environment except span-shaped telemetry over TLS to `api.provenex.ai`.

## What you need

- An AI agent emitting OTel-GenAI traces. Any of these shapes work natively:
  - OpenTelemetry-GenAI semantic conventions (the standard)
  - OpenInference (Arize / Phoenix)
  - LangSmith via OTLP
  - LangFuse via OTLP
  - OpenLLMetry (Traceloop)
  - Vercel AI SDK / Mastra
- An OTel Collector (or your existing one) you can configure with a new exporter
- 10 minutes

If you can't generate live telemetry today, you can replay a saved `.otlp.json` file via `curl` and see verdicts immediately — useful for evaluation before integrating.

> **Want to check your current instrumentation before integrating?** [docs/telemetry-checklist.md](telemetry-checklist.md) has the full tiered list — what's required, what's strongly preferred, what each missing piece costs you in catch coverage. Most customers using a modern agent framework pass the bar automatically; the checklist makes it explicit so your security team can verify before running the eval.

## "I don't have OTLP/JSON traces yet — how do I get them?"

The trial accepts OpenTelemetry-formatted traces. Most modern agent frameworks emit them either by default or with one-line instrumentation. Pick yours below.

### LangChain / LangGraph

```python
# pip install opentelemetry-instrumentation-langchain
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.langchain import LangChainInstrumentor

trace.set_tracer_provider(TracerProvider())
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(
        endpoint="https://api.provenex.ai/v1/traces",
        headers={"Authorization": "Bearer pvx_trial_xxx"},
    ))
)
LangChainInstrumentor().instrument()
# Now your existing LangChain code emits OTLP-GenAI to Provenex.
```

### LlamaIndex

```python
# pip install llama-index-instrumentation-otel
from llama_index.core import Settings
from llama_index.instrumentation.otel import setup_tracing

setup_tracing(
    endpoint="https://api.provenex.ai/v1/traces",
    headers={"Authorization": "Bearer pvx_trial_xxx"},
)
```

### OpenAI SDK (direct)

```python
# pip install openai-instrumentation opentelemetry-sdk
# Same OTel exporter setup as above, then:
from openinference.instrumentation.openai import OpenAIInstrumentor
OpenAIInstrumentor().instrument()
```

### Anthropic SDK (direct)

```python
# pip install opentelemetry-instrumentation-anthropic (community)
from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor
AnthropicInstrumentor().instrument()
```

### LangSmith (already using it for observability)

Export traces from LangSmith's UI as JSON, save as `*.otlp.json` files, then use `provenex-ingest batch ./exports/` or curl. LangSmith also supports direct OTLP forwarding — see Step 3 of this guide.

### LangFuse

```python
from langfuse import Langfuse
langfuse = Langfuse(
    host="https://api.provenex.ai",
    public_key="pvx_trial_xxx",
    secret_key="pvx_trial_xxx",  # trial uses single Bearer
)
```

### AWS Bedrock Agents

Bedrock Agents emit a custom TracePart structure that needs conversion. The repo includes `tools/blind_corpus/convert_bedrock_to_otlp.py`. Pipe CloudWatch logs through it, then `provenex-ingest batch` the output directory.

### Vercel AI SDK / Mastra

OpenTelemetry instrumentation is built in. Add the OTLP exporter env vars:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.provenex.ai
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer pvx_trial_xxx"
```

### Already running an OTel Collector?

Path B in your welcome email. Add one exporter block — no code change anywhere.

### None of the above (or custom instrumentation)

Two options:
1. **Capture your existing agent logs into OTLP-shaped JSON** with a small adapter — this is what we ship `tools/blind_corpus/` for. If your logs already include trace_id + span_id + parent_span_id + per-span attributes (tool name, operation type, etc.), it's a structural mapping job we can help with.
2. **Use our bundled sample bundle** to see the engine work end-to-end while you set up real instrumentation. From [`samples/`](../samples/): `PROVENEX_API_KEY=pvx_trial_xxx ./try-me.sh`.

---

## Step 1 — Get a trial API key

Sign up at https://provenex.ai/trial (Phase 2 — for now request a key from us directly). You'll receive an email with:

```
Tenant ID:       <uuid>
API key:         pvx_trial_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HMAC salt:       <random>      (reserved for the privacy-preserving ingestor; not needed yet)
Trial expires:   <30 days out>
```

The key is shown **once** at issuance. Store it in your secret manager.

Verify your key works:

```bash
export PROVENEX_API_KEY="pvx_trial_..."

curl https://provenex-verdict.fly.dev/v1/health/key \
  -H "Authorization: Bearer $PROVENEX_API_KEY"
```

You should see:

```json
{
  "tenant_id": "...",
  "plan": "trial",
  "trial_expires_at": "..."
}
```

## Step 2 — Send your first OTLP batch

The simplest path is `curl` with an existing trace file:

```bash
curl -X POST https://provenex-verdict.fly.dev/v1/receipts \
  -H "Authorization: Bearer $PROVENEX_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/path/to/your-trace.otlp.json
```

The response is the per-egress verdict from the engine, evaluated end-to-end:

```json
{
  "accepted": true,
  "receipts_ingested": 1,
  "red_verdicts": 1,
  "verdicts": [
    {
      "verdict": "red",
      "risk": "high",
      "binding_reason": "cross-zone-composition",
      "correlation_key": "<span id>",
      "explanation": "Data classified [untrusted-external, privileged-pii] reached an external-egress destination, which this guideline forbids."
    }
  ],
  "tenant_id": "..."
}
```

**Body limit per request:** 16 MiB. Batch your collector's exports below that.

Don't have an OTel trace handy? Try Provenex's bundled EchoLeak reconstruction:

```bash
# Clone the repo, then:
curl -X POST https://provenex-verdict.fly.dev/v1/receipts \
  -H "Authorization: Bearer $PROVENEX_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @fixtures/external/breach_disclosures/echoleak/reconstructed_trace.otlp.json
```

You should see `red_verdicts: 1` with `binding_reason: "cross-zone-composition"`. That's the EchoLeak (CVE-2025-32711) shape catching cleanly with zero customer config.

## Step 3 — Wire your OTel Collector

The trial endpoint is OTLP/HTTP-compatible at the `/v1/traces` path (standard) and `/v1/receipts` (alias). Stock OTel Collector configuration:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  # Your existing exporters stay
  otlp/honeycomb:
    endpoint: api.honeycomb.io:443
    headers:
      x-honeycomb-team: ${HONEYCOMB_API_KEY}

  # Add this exporter for Provenex
  otlphttp/provenex:
    endpoint: https://provenex-verdict.fly.dev
    headers:
      Authorization: "Bearer ${PROVENEX_API_KEY}"
    # The collector posts to <endpoint>/v1/traces by default, which is
    # exactly what Provenex's /v1/traces alias accepts.

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/honeycomb, otlphttp/provenex]
```

Set `PROVENEX_API_KEY` in the collector's env, restart, and watch your agent's traffic flow to both your normal observability AND to Provenex.

### Alternative: ship traces directly from your agent

If your agent uses LangSmith / LangFuse / OpenLLMetry / Vercel AI SDK and exports via OTLP/HTTP, just add Provenex as a second exporter endpoint. Most SDKs let you configure multiple OTLP destinations.

LangChain (with OpenLLMetry):

```python
from traceloop.sdk import Traceloop

Traceloop.init(
    app_name="my-agent",
    api_endpoint="https://provenex-verdict.fly.dev",
    api_key="pvx_trial_...",
    disable_batch=False,
)
```

LangFuse:

```python
from langfuse import Langfuse

langfuse = Langfuse(
    host="https://provenex-verdict.fly.dev",
    public_key="pvx_trial_...",
    secret_key="pvx_trial_...",   # same value; trial uses single Bearer
)
```

## Step 4 — Retrieve verdicts

The synchronous response from `/v1/receipts` returns verdicts for the batch you just posted. For longer-term retrieval (analyst review, SIEM forwarding, dashboard polling), use:

```bash
curl "https://provenex-verdict.fly.dev/v1/verdicts?limit=100&since=2026-06-01T00:00:00Z" \
  -H "Authorization: Bearer $PROVENEX_API_KEY"
```

Returns the most-recent Red verdicts for your tenant, including the full signed verdict artifact (suitable for forensic archiving). Verdicts are ed25519-signed with key `trial-2026-06`; verify them against the public key in your verdict artifact archive.

### Query parameters

| Param | Default | Notes |
|---|---|---|
| `since` | 24 hours ago | RFC3339 timestamp |
| `limit` | 100 | hard cap 1000 per request |

## Step 5 — Read the verdict

Each verdict carries:

- **`verdict`** — `red` (catches something), `policy-cleared` (closure walked clean), or other
- **`risk`** — `high` / `medium` / `low` / `unknown`
- **`binding_reason`** — the policy that fired:
  - `cross-zone-composition` — the catch the deck describes: untrusted source + privileged data → external egress
  - `sensitive-retrieval-egress` — PII reached an external destination (the simpler shape)
  - `untrusted-influence-on-privileged-action` — untrusted input drove a real-consequence action inside your tenant
  - `composition-light` — untrusted → egress, no PII required
- **`hits[].explanation`** — human-readable description of what fired
- **`closure`** — the receipts on the lineage path from source to egress (in the full audit-log retrieval)

A Red verdict means **the chain Provenex reconstructed crosses your trust boundaries**. The next steps are:

1. Read the closure to see which spans are on the path
2. Decide whether the closure represents a real risk in your environment
3. Tune your `trust_zones.yaml` if the engine over-classified anything (Phase 2 — dashboard editor coming)

## What we see and what we don't

**We see:**

- Span IDs, parent/child relationships
- Tool names (`gen_ai.tool.name`)
- Agent names (`gen_ai.agent.name`)
- Resource URIs (`gen_ai.data_source.id` — e.g. `outlook://mailbox/inbox/...`)
- Span timing
- End-user identifiers (`enduser.id` — usually an email)

**We currently see (Phase 1 — will be hash-only in Phase 1.5):**

- `gen_ai.input.messages` — prompts
- `gen_ai.output.messages` — assistant outputs
- `gen_ai.tool.call.arguments` and `.result` — tool I/O

**Phase 1.5 (open-source ingestor, ETA July 2026)** will let you hash these fields client-side using the HMAC salt issued at trial signup. Provenex will see only structural metadata + content hashes; cross-source linking still works via the hash. For the trial, send what your collector emits — your enterprise environment can audit the over-the-wire payload against the live ingest log.

## Limits during trial

| | Value |
|---|---|
| Trial duration | 30 days |
| Body size per request | 16 MiB |
| Rate limit | 100 req/min per tenant (soft; contact us if you need more) |
| Verdict retention | 30 days from issuance |
| Cross-batch lineage | Phase 2 — currently each batch is scoped to itself |

## Frequently asked

**Where does my data go?** US East (Ashburn) via Fly.io. EU residency in Phase 3. Telemetry is encrypted in transit (TLS 1.3) and at rest (Neon Postgres TDE). No third-party data sharing.

**What if I want to test air-gapped?** Phase 3 ships the verdict-service binary you can run on your own infrastructure with your own keys. Trial is hosted-only.

**Does Provenex see customer PII?** Today: yes if your traces carry it (prompts, retrieved chunks). Phase 1.5: no, only content hashes. See "What we see and what we don't" above.

**Can I retrieve the signed verdict for compliance?** Yes — `/v1/verdicts` returns the full ed25519-signed artifact. Verify against the public key in `trial-2026-06` (publishable on request).

**What happens at day 30?** The API key starts returning HTTP 402 Payment Required. Your historical verdicts stay queryable for 30 days. Convert with a contract; we'll re-enable the key without losing context.

## Troubleshooting

**`401 unknown key`** — Your API key is wrong. Re-check the value you copied from the signup email. The prefix should be `pvx_trial_`.

**`402 trial expired`** — Trial period is up. Hit https://provenex.ai/contact to extend or convert.

**`accepted: true, receipts_ingested: 0`** — The OTLP body parsed but no egress points were detected. Verify your trace has tool calls / outbound spans with `gen_ai.operation.name = execute_tool` or `http.request.method` set.

**`accepted: true, red_verdicts: 0`** — The egress points classified but no closure formed the cross-zone shape. Usually means the upstream lineage (parent_span_id chains) wasn't fully captured. Use `/v1/verdicts` to inspect what verdict shape was emitted (`not-covered` means insufficient lineage; `policy-cleared` means clean closure).

**400 errors with cryptic prose** — Send us the response body. The engine surfaces structured errors but we're still tuning the trial-product surface.

## What's next

Once you've seen Red verdicts firing on your real telemetry, the natural next steps are:

1. **Authoring your `trust_zones.yaml`** — tell the engine which of YOUR vendor URIs are privileged-PII, which destinations count as external-egress. Today this requires a custom build; Phase 2 ships a dashboard editor.
2. **Wiring verdicts to your SIEM** — Provenex emits Splunk-HEC / Datadog / ECS-native NDJSON via the upcoming `/v1/verdicts/stream` SSE endpoint. Today, poll `/v1/verdicts?since=` from your SOAR.
3. **Enforcement at the egress boundary** — Phase 3 ships the rung-3 PEP that holds privileged actions and emits `require_approval` decisions. Today is observe-only.

## Help

- This guide: https://github.com/yourorg/provenex-mvp/blob/main/docs/onboarding-trial.md
- Engine architecture: [docs/how-provenex-catches.md](how-provenex-catches.md)
- The pitch context: [README.md](../README.md)
- Email / Slack / something — TBD by Phase 2
