# Provenex trial: onboarding guide

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

If you can't generate live telemetry today, you can replay a saved `.otlp.json` file via `curl` and see verdicts immediately; useful for evaluation before integrating.

> **Want to check your current instrumentation before integrating?** [docs/telemetry-checklist.md](telemetry-checklist.md) has the full tiered list; what's required, what's strongly preferred, what each missing piece costs you in catch coverage. Most customers using a modern agent framework pass the bar automatically; the checklist makes it explicit so your security team can verify before running the eval.

## "I don't have OTLP/JSON traces yet: how do I get them?"

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

Export traces from LangSmith's UI as JSON, save as `*.otlp.json` files, then use `provenex-ingest batch ./exports/` or curl. LangSmith also supports direct OTLP forwarding; see Step 3 of this guide.

### LangFuse

LangFuse's SDK authenticates against LangFuse, not Provenex. Two integration shapes:

1. **Fan-out at the OTel layer (recommended).** If LangFuse is already running OTel under the hood, configure your collector to fan-out one copy to LangFuse and a second copy to `https://api.provenex.ai/v1/traces` with the Provenex Bearer. See the OTel Collector block in Step 3.
2. **Export and replay.** Export LangFuse's stored traces as OTLP/JSON, then `provenex-ingest batch ./exports/` (same as the LangSmith path above).

We do not accept the LangFuse public/secret-key pair on the Provenex endpoint.

### AWS Bedrock Agents

Bedrock Agents emit a custom TracePart structure that needs conversion. The repo includes `tools/blind_corpus/convert_bedrock_to_otlp.py`. Pipe CloudWatch logs through it, then `provenex-ingest batch` the output directory.

### Vercel AI SDK / Mastra

OpenTelemetry instrumentation is built in. Add the OTLP exporter env vars:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.provenex.ai
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer pvx_trial_xxx"
```

### Already running an OTel Collector?

Path B in your welcome email. Add one exporter block; no code change anywhere.

### None of the above (or custom instrumentation)

Two options:
1. **Capture your existing agent logs into OTLP-shaped JSON** with a small adapter; this is what we ship `tools/blind_corpus/` for. If your logs already include trace_id + span_id + parent_span_id + per-span attributes (tool name, operation type, etc.), it's a structural mapping job we can help with.
2. **Use our bundled sample bundle** to see the engine work end-to-end while you set up real instrumentation. From [`samples/`](../samples/): `PROVENEX_API_KEY=pvx_trial_xxx ./try-me.sh`.

---

## Deploying in your cloud: pick your shape

Where you run **what** depends on whether you're using a hosted SaaS, your own cloud (AWS / GCP / Azure), or both. The integration footprint is small (TLS to `api.provenex.ai` on 443), but the deployment pattern matters when you're at multi-node or multi-region scale. Pick the one that matches your setup.

### Pattern A: Single VM / single container (greenfield, dev, evaluation)

Run your agent with an OTLP exporter pointed at `https://api.provenex.ai/v1/traces`. The exporter is the standard OpenTelemetry one your framework already ships (LangChain, LlamaIndex, OpenAI SDK with `openinference-instrumentation`, etc.). It batches and retries on its own.

That is the entire customer-side footprint. **No `provenex-ingest` binary, no OTel Collector, no sidecar.** The ingest engine runs server-side; your agent's OTLP exporter is the only moving part.

You'd add the optional `provenex-ingest` binary (Pattern C below) only if you need (a) HMAC content-hashing so prompts and tool I/O are hashed before they leave your environment, (b) batch-replay of historical `.otlp.json` files, (c) a local OTLP receiver your OTel Collector posts to instead of `api.provenex.ai`, or (d) the `--report` HTML artifact and verdict-feedback share-back.

### Pattern B: Multi-node, single region (typical production)

Run an **OpenTelemetry Collector** (one or a small fleet, fronting your nodes) as the central trace aggregator. Add Provenex as a second OTLP exporter alongside whatever observability backend you already use (Datadog / Honeycomb / Splunk / Application Insights / etc.). Your existing data flow doesn't change; Provenex gets a copy via fan-out. See "Forwarding from your existing observability stack" below for the exact config block per platform.

### Pattern C: Multi-region, residency-sensitive (EU / FedRAMP / healthcare)

Run **provenex-ingest in `--mode hash`** as a regional sidecar near each Collector. Per-tenant HMAC salt hashes prompts + tool I/O locally; only structural metadata + content hashes cross the region boundary to `api.provenex.ai`. Cross-region linking still works via the hashes; same hashed value on two continents resolves to one cross-receipt edge in the closure walker.

### Pattern D: Hosted observability already (Datadog / Splunk / LangSmith / Langfuse / Phoenix / Helicone)

You don't deploy anything new client-side. Your existing platform's collector or proxy grows one extra exporter block pointing at Provenex. See "Forwarding from your existing observability stack" below.

---

## Install patterns by platform

The CLI binary (`provenex-ingest`) is light enough to run as a sidecar, DaemonSet, or systemd service. Three install paths (cargo / docker / shell installer) at [/docs/install](install). Below are the deployment shapes per cloud.

### AWS

| Workload | Pattern |
|---|---|
| **ECS / Fargate** | Add `provenex-ingest` as a sidecar container in your task definition. Or add a second exporter to your existing ADOT Collector; no new container needed. |
| **EKS** | DaemonSet running `provenex-ingest listen` per node; pods POST to `localhost:4318`. Or a second exporter on your central OTel Collector deployment. |
| **EC2 / systemd** | Cargo / shell-installer install, drop a unit file calling `provenex-ingest watch /var/log/agent/`. |
| **Lambda** | OTel Lambda Layer + the OTLP env vars below; no binary required. |
| **AppRunner** | Add the OTLP env vars on the service; AppRunner's built-in OTel exporter handles forwarding. |
| **Bedrock managed agents** | No app-side instrumentation needed. CloudWatch Logs subscription filter → Kinesis Firehose → Provenex HTTPS endpoint (full Terraform below). |

### GCP

| Workload | Pattern |
|---|---|
| **GKE** | DaemonSet (same as EKS). |
| **Cloud Run** | Sidecar container; the Provenex-ingest container shares the pod network providing `localhost:4318`. |
| **GCE / systemd** | Same as EC2. |
| **Cloud Functions Gen2** | Env vars on the function, OTel-instrumented runtime sends directly to `api.provenex.ai`. |
| **Vertex AI managed agents** | No app code change. Cloud Logging Sink → Pub/Sub push subscription → Provenex (full gcloud commands below). |

### Azure

| Workload | Pattern |
|---|---|
| **AKS** | DaemonSet. |
| **App Service (Premium)** | Sidecar container. |
| **Container Apps** | Sidecar. |
| **Functions Premium** | Sidecar. |
| **Azure OpenAI / AI Foundry diagnostic logs** | Diagnostic Settings → Event Hub → OTel Collector (`azureeventhub` receiver) → Provenex (full config below). |

### Heroku / Fly.io / Railway / Render

Buildpack or Dockerfile install of `provenex-ingest` as a second process. Use the foreman/Procfile to start both the app and `provenex-ingest listen --bind 0.0.0.0:4318` (or just set OTel env vars on the app and skip the binary entirely).

### Kubernetes (any cloud)

```yaml
# DaemonSet: one provenex-ingest per node, exposes localhost:4318 to pods
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: provenex-ingest
  namespace: observability
spec:
  selector: { matchLabels: { app: provenex-ingest } }
  template:
    metadata: { labels: { app: provenex-ingest } }
    spec:
      hostNetwork: true
      containers:
      - name: ingest
        image: ghcr.io/provenex/provenex-ingest:latest
        args: ["listen", "--bind", "0.0.0.0:4318"]
        env:
        - name: PROVENEX_API_KEY
          valueFrom: { secretKeyRef: { name: provenex, key: api-key } }
        - name: PROVENEX_HMAC_SALT
          valueFrom: { secretKeyRef: { name: provenex, key: hmac-salt } }
        - name: PROVENEX_MODE
          value: "hash"   # remove for plain-mode trial; keep for prod
        ports: [{ containerPort: 4318, hostPort: 4318 }]
        resources:
          requests: { cpu: "50m", memory: "64Mi" }
          limits:   { cpu: "200m", memory: "256Mi" }
```

---

## Multi-region telemetry: how it stitches together

Provenex correlates lineage across telemetry batches **server-side**. You can have agents in multiple regions sending to the same trial endpoint and the closure walker reconstructs cross-region chains automatically. The only thing you do client-side:

1. Each region's `provenex-ingest` (or OTel Collector) uses the **same API key + same HMAC salt**. Different salts break cross-region hash equality.
2. `enduser.id` / `gen_ai.user.id` is stable across regions (so cross-agent risk propagation catches "Alice's ChatGPT in EU elevated her US-East in-house agent").
3. `service.name` disambiguates regional deployments of the same agent (e.g. `service.name=order-bot-us-east` vs. `=order-bot-eu-west`).

You **don't** need to:

- Co-locate Provenex with your data plane (Phase 3 ships regional Provenex endpoints; Phase 1 is US-East single-region).
- Forward all regions through a central aggregator first; every region can post directly to `api.provenex.ai`. The closure walker dedupes by `trace_id` + `span_id` server-side.

---

## Forwarding from your existing observability stack

If you already pay for a SaaS observability platform, you don't replace it. Provenex is **always additive**. your existing data flow doesn't change; we receive a copy via a second exporter block.

### Datadog

Datadog has no native HTTPS webhook for LLM traces; the supported fan-out is the OpenTelemetry Collector (or Datadog's own distribution, DDOT, which ships inside the Datadog Agent) with two exporters in one pipeline.

```yaml
exporters:
  datadog:
    api:
      key: ${env:DD_API_KEY}
      site: datadoghq.com
  otlphttp/provenex:
    endpoint: https://api.provenex.ai/v1/traces
    headers:
      Authorization: "Bearer ${env:PROVENEX_API_KEY}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [datadog, otlphttp/provenex]
```

Apps continue emitting OTLP to the local Collector; the Collector fans out. Reference: [Datadog OTel Collector exporter docs](https://docs.datadoghq.com/opentelemetry/setup/collector_exporter/).

### Splunk Observability Cloud

The Splunk Distribution of OTel Collector is plain upstream OTel; add a second `otlphttp` exporter alongside the Splunk APM exporter (`sapm` is deprecated; `otlphttp` is the current recommended path for both destinations).

```yaml
exporters:
  otlphttp:
    endpoint: "https://ingest.${SPLUNK_REALM}.signalfx.com"
    headers: {"X-SF-Token": "${SPLUNK_ACCESS_TOKEN}"}
  otlphttp/provenex:
    endpoint: https://api.provenex.ai/v1/traces
    headers: {"Authorization": "Bearer ${env:PROVENEX_API_KEY}"}

service:
  pipelines:
    traces:
      receivers: [otlp, jaeger, zipkin]
      processors: [batch]
      exporters: [otlphttp, otlphttp/provenex]
```

Reference: [Splunk OTel Collector otlphttp exporter](https://help.splunk.com/en/splunk-observability-cloud/manage-data/splunk-distribution-of-the-opentelemetry-collector/get-started-with-the-splunk-distribution-of-the-opentelemetry-collector/collector-components/exporters/otlphttp-exporter).

### AWS Bedrock (managed agents: no app-side instrumentation)

Bedrock invocation logs land in CloudWatch Logs and/or S3 (no native OTLP). The production pattern is **CloudWatch Logs subscription filter → Kinesis Data Firehose HTTP endpoint → Provenex**. Bodies up to 100 KB are delivered inline; larger ones land in S3 and Firehose includes the S3 pointer.

```hcl
# 1. Enable Bedrock model invocation logging to CloudWatch Logs (one-time)
resource "aws_bedrock_model_invocation_logging_configuration" "this" {
  logging_config {
    cloudwatch_config {
      log_group_name = aws_cloudwatch_log_group.bedrock.name
      role_arn       = aws_iam_role.bedrock_logging.arn
    }
    embedding_data_delivery_enabled = true
    image_data_delivery_enabled     = true
    text_data_delivery_enabled      = true
  }
}

# 2. Subscription filter routes all log records to Firehose
resource "aws_cloudwatch_log_subscription_filter" "bedrock" {
  name            = "bedrock-to-provenex"
  log_group_name  = aws_cloudwatch_log_group.bedrock.name
  destination_arn = aws_kinesis_firehose_delivery_stream.provenex.arn
  filter_pattern  = ""
  role_arn        = aws_iam_role.cwl_to_firehose.arn
}

# 3. Firehose delivers to Provenex over HTTPS
resource "aws_kinesis_firehose_delivery_stream" "provenex" {
  name        = "bedrock-to-provenex"
  destination = "http_endpoint"
  http_endpoint_configuration {
    url        = "https://api.provenex.ai/v1/aws/bedrock"
    name       = "Provenex"
    access_key = var.provenex_api_key
    buffering_size     = 5
    buffering_interval = 60
    s3_backup_mode     = "FailedDataOnly"
  }
}
```

Provenex translates the Bedrock invocation-log envelope to OTel-GenAI semantic conventions on receive. For Bedrock SDK callers (your app code calling Converse), the OpenInference Bedrock instrumentor at the app layer is also fine; but the invocation-log path is what captures everything for **managed Bedrock Agents and Knowledge Bases** where you don't own the call site.

Reference: [Bedrock model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html) + [Firehose HTTP delivery](https://docs.aws.amazon.com/firehose/latest/dev/writing-with-cloudwatch-logs.html).

### Azure OpenAI / Azure AI Foundry

Two paths depending on whether you own the call site:

**App-side (your code calls Azure OpenAI):** add a second `otlphttp` exporter on whatever OTel pipeline Application Insights already runs through.

**Service-side diagnostic logs (the Bedrock-equivalent path):** Diagnostic Settings → Event Hub → OTel Collector (`azureeventhub` receiver) → Provenex.

```yaml
receivers:
  azureeventhub:
    connection: ${env:EVENTHUB_CONN_STRING}
    format: "azure"

exporters:
  otlphttp/provenex:
    endpoint: https://api.provenex.ai/v1/traces
    headers: {"Authorization": "Bearer ${env:PROVENEX_API_KEY}"}

service:
  pipelines:
    logs:
      receivers: [azureeventhub]
      exporters: [otlphttp/provenex]
```

Reference: [Azure OpenAI monitoring reference](https://learn.microsoft.com/en-us/azure/foundry/openai/monitor-openai-reference).

### GCP Vertex AI

Vertex emits Cloud Audit Logs (always on) and optional request-response logging into BigQuery. Fan out audit logs via a Logging Sink → Pub/Sub → push subscription to Provenex.

```bash
# Sink Vertex audit logs to Pub/Sub
gcloud logging sinks create provenex-vertex \
  pubsub.googleapis.com/projects/$PROJECT/topics/provenex-vertex \
  --log-filter='resource.type="aiplatform.googleapis.com/Endpoint"
                OR protoPayload.serviceName="aiplatform.googleapis.com"'

# Grant the sink writer the pubsub.publisher role (gcloud prints the writer SA)
gcloud pubsub topics add-iam-policy-binding provenex-vertex \
  --member=serviceAccount:<writer-sa-from-above> --role=roles/pubsub.publisher

# Push subscription → Provenex
gcloud pubsub subscriptions create provenex-push \
  --topic=provenex-vertex \
  --push-endpoint=https://api.provenex.ai/v1/gcp/vertex \
  --push-auth-service-account=provenex-pusher@$PROJECT.iam.gserviceaccount.com
```

For trace-grade telemetry from app code, the OpenInference Vertex AI instrumentor is also clean. The audit-log forwarder above is the right path when you need to capture managed Agent Engine traffic the SDK doesn't see.

Reference: [Vertex AI request-response logging](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/request-response-logging).

### LangSmith / Langfuse / Phoenix (Arize) / Helicone

None have first-class outbound webhooks for individual trace events. All are OTel-compatible on ingest, so the right pattern is one Collector with multiple `otlphttp` exporters.

```yaml
exporters:
  otlphttp/langsmith:
    endpoint: https://api.smith.langchain.com/otel
    headers: {"x-api-key": "${env:LANGSMITH_API_KEY}"}
  otlphttp/langfuse:
    endpoint: https://cloud.langfuse.com/api/public/otel
    headers: {"Authorization": "Basic ${env:LANGFUSE_B64}"}
  otlphttp/phoenix:
    endpoint: https://app.phoenix.arize.com/v1/traces
    headers: {"api_key": "${env:PHOENIX_API_KEY}"}
  otlphttp/provenex:
    endpoint: https://api.provenex.ai/v1/traces
    headers: {"Authorization": "Bearer ${env:PROVENEX_API_KEY}"}

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/langsmith, otlphttp/langfuse, otlphttp/phoenix, otlphttp/provenex]
```

LangSmith additionally supports `LANGSMITH_OTEL_ENABLED=true` for direct OTel ingest from the LangChain SDK. Helicone is a proxy, not a destination; if customers use Helicone, configure its OTel forwarding to Provenex directly (a second exporter URL in the Helicone dashboard).

References: [LangSmith with OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry), [OpenInference instrumentors](https://arize-ai.github.io/openinference/).

---

## Step 1. Get a trial API key

Sign up at https://signup.provenex.ai/signup (self-serve; takes about a minute). You'll receive an email with:

```
Tenant ID:       <uuid>
API key:         pvx_trial_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HMAC salt:       <random>      (reserved for the privacy-preserving ingestor; not needed yet)
Trial expires:   <30 days out>
```

The key is shown **once** at issuance. Store it in your secret manager.

Verify your key works:

```bash
export PROVENEX_API_KEY="pvx_trial_REPLACE_WITH_YOUR_KEY_SUFFIX"

curl https://api.provenex.ai/v1/health/key \
  -H "Authorization: Bearer $PROVENEX_API_KEY"
```

You should see:

```json
{
  "tenant_id": "<uuid>",
  "plan": "trial",
  "trial_expires_at": "<iso-8601 timestamp 30 days out>"
}
```

## Step 2. Send your first OTLP batch

The simplest path is `curl` with an existing trace file:

```bash
curl -X POST https://api.provenex.ai/v1/receipts \
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
  "tenant_id": ". ."
}
```

**Body limit per request:** 16 MiB. Batch your collector's exports below that.

Don't have an OTel trace handy? Try Provenex's bundled EchoLeak reconstruction:

```bash
# Clone the repo, then:
curl -X POST https://api.provenex.ai/v1/receipts \
  -H "Authorization: Bearer $PROVENEX_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @fixtures/external/breach_disclosures/echoleak/reconstructed_trace.otlp.json
```

You should see `red_verdicts: 1` with `binding_reason: "cross-zone-composition"`. That's the EchoLeak (CVE-2025-32711) shape catching cleanly with zero customer config.

## Step 3. Wire your OTel Collector

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
    endpoint: https://api.provenex.ai
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
    api_endpoint="https://api.provenex.ai",
    api_key="pvx_trial_. .",
    disable_batch=False,
)
```

LangFuse:

```python
from langfuse import Langfuse

langfuse = Langfuse(
    host="https://api.provenex.ai",
    public_key="pvx_trial_. .",
    secret_key="pvx_trial_. .",   # same value; trial uses single Bearer
)
```

## Step 4. Retrieve verdicts

The synchronous response from `/v1/receipts` returns verdicts for the batch you just posted. For longer-term retrieval (analyst review, SIEM forwarding, dashboard polling), use:

```bash
curl "https://api.provenex.ai/v1/verdicts?limit=100&since=2026-06-01T00:00:00Z" \
  -H "Authorization: Bearer $PROVENEX_API_KEY"
```

Returns the most-recent Red verdicts for your tenant, including the full signed verdict artifact (suitable for forensic archiving). Verdicts are ed25519-signed with key `trial-2026-06`; verify them against the public key in your verdict artifact archive.

### Query parameters

| Param | Default | Notes |
|---|---|---|
| `since` | 24 hours ago | RFC3339 timestamp |
| `limit` | 100 | hard cap 1000 per request |

## Step 5. Read the verdict

Each verdict carries:

- **`verdict`**. `red` (catches something), `policy-cleared` (closure walked clean), or other
- **`risk`**. `high` / `medium` / `low` / `unknown`
- **`binding_reason`**. the policy that fired:
  - `cross-zone-composition`. the catch the deck describes: untrusted source + privileged data → external egress
  - `sensitive-retrieval-egress`. PII reached an external destination (the simpler shape)
  - `untrusted-influence-on-privileged-action`. untrusted input drove a real-consequence action inside your tenant
  - `composition-light`. untrusted → egress, no PII required
- **`hits[].explanation`**. human-readable description of what fired
- **`closure`**. the receipts on the lineage path from source to egress (in the full audit-log retrieval)

A Red verdict means **the chain Provenex reconstructed crosses your trust boundaries**. The next steps are:

1. Read the closure to see which spans are on the path
2. Decide whether the closure represents a real risk in your environment
3. Tune your `trust_zones.yaml` if the engine over-classified anything (Phase 2; dashboard editor coming)

## What we see and what we don't

**We see:**

- Span IDs, parent/child relationships
- Tool names (`gen_ai.tool.name`)
- Agent names (`gen_ai.agent.name`)
- Resource URIs (`gen_ai.data_source.id`. e.g. `outlook://mailbox/inbox/. .`)
- Span timing
- End-user identifiers (`enduser.id`. usually an email)

**We currently see (Phase 1; will be hash-only in Phase 1.5):**

- `gen_ai.input.messages`. prompts
- `gen_ai.output.messages`. assistant outputs
- `gen_ai.tool.call.arguments` and `.result`. tool I/O

**Phase 1.5 (open-source ingestor, ETA July 2026)** will let you hash these fields client-side using the HMAC salt issued at trial signup. Provenex will see only structural metadata + content hashes; cross-source linking still works via the hash. For the trial, send what your collector emits; your enterprise environment can audit the over-the-wire payload against the live ingest log.

## Limits during trial

| | Value |
|---|---|
| Trial duration | 30 days |
| Body size per request | 16 MiB |
| Rate limit | 100 req/min per tenant (soft; contact us if you need more) |
| Verdict retention | 30 days from issuance |
| Cross-batch lineage | Phase 2; currently each batch is scoped to itself |

## Frequently asked

**Where does my data go?** US East (Ashburn) via Fly.io. EU residency in Phase 3. Telemetry is encrypted in transit (TLS 1.3) and at rest (Neon Postgres TDE). No third-party data sharing.

**What if I want to test air-gapped?** Phase 3 ships the verdict-service binary you can run on your own infrastructure with your own keys. Trial is hosted-only.

**Does Provenex see customer PII?** Today: yes if your traces carry it (prompts, retrieved chunks). Phase 1.5: no, only content hashes. See "What we see and what we don't" above.

**Can I retrieve the signed verdict for compliance?** Yes; `/v1/verdicts` returns the full ed25519-signed artifact. Verify against the public key in `trial-2026-06` (publishable on request).

**What happens at day 30?** The API key starts returning HTTP 402 Payment Required. Your historical verdicts stay queryable for 30 days. Convert with a contract; we'll re-enable the key without losing context.

## Troubleshooting

**`401 unknown key`**. Your API key is wrong. Re-check the value you copied from the signup email. The prefix should be `pvx_trial_`.

**`402 trial expired`**. Trial period is up. Hit https://provenex.ai/contact to extend or convert.

**`accepted: true, receipts_ingested: 0`**. The OTLP body parsed but no egress points were detected. Verify your trace has tool calls / outbound spans with `gen_ai.operation.name = execute_tool` or `http.request.method` set.

**`accepted: true, red_verdicts: 0`**. The egress points classified but no closure formed the cross-zone shape. Usually means the upstream lineage (parent_span_id chains) wasn't fully captured. Use `/v1/verdicts` to inspect what verdict shape was emitted (`not-covered` means insufficient lineage; `policy-cleared` means clean closure).

**400 errors with cryptic prose**. Send us the response body. The engine surfaces structured errors but we're still tuning the trial-product surface.

## What's next

Once you've seen Red verdicts firing on your real telemetry, the natural next steps are:

1. **Authoring your `trust_zones.yaml`**. tell the engine which of YOUR vendor URIs are privileged-PII, which destinations count as external-egress. Today this requires a custom build; Phase 2 ships a dashboard editor.
2. **Wiring verdicts to your SIEM**. Provenex emits Splunk-HEC / Datadog / ECS-native NDJSON via the upcoming `/v1/verdicts/stream` SSE endpoint. Today, poll `/v1/verdicts?since=` from your SOAR.
3. **Enforcement at the egress boundary**. Phase 3 ships the rung-3 PEP that holds privileged actions and emits `require_approval` decisions. Today is observe-only.

## Help

- Engine architecture: [docs/how-provenex-catches.md](how-provenex-catches.md)
- Telemetry-shape pre-flight check: [docs/telemetry-checklist.md](telemetry-checklist.md)
- Data-handling posture: [docs/data-handling-posture.md](data-handling-posture.md)
- The pitch context: [README.md](../README.md)
- **Email skulk@provenex.ai.** Bug reports, feature asks, trace-shape questions, "this fixture surprised me" feedback all go to the same inbox. Reply to your welcome email or write directly; we read every one.
