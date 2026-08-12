# Telemetry checklist: what to emit for best results

A short, actionable checklist for customers integrating Provenex, tiered by how
much catching power each piece unlocks. Supported frameworks can provide useful
discovery when their instrumentation and OTLP exporter are actually enabled.
Framework presence alone does not prove coverage; qualify a representative
capture before the evaluation.

All actual customer telemetry goes to the customer-local ADR-008 edge. Do not
point an exporter at the shared scorer. The edge keeps raw telemetry and sends
only the exact HMAC-minimized scoring closure shown in **Data boundary → Your
data**.

## TL;DR: minimum viable telemetry

If you can answer **yes** to these three, you're ready to import telemetry into
your local Provenex workspace and begin discovery:

- [ ] Your agent emits OpenTelemetry traces (any of the listed shapes below)
- [ ] Each span carries `trace_id` and `span_id`
- [ ] The chain of `parent_span_id` from the agent's output back to its inputs is reconstructable

Many modern agent frameworks can pass the ingest bar once their instrumentation
and exporter are actually enabled. That proves only that Provenex can normalize
the capture: detection readiness still depends on operation typing, source and
destination classification, action semantics, and usable parentage. Traditional
HTTP, REST, and RPC/gRPC services likewise need stable identity, operation,
destination, and parentage fields. If you're not sure, import an approved sample
into the local workspace or run
`provenex-scan` locally; do not email a customer trace or send it to staging.

If spans are unavailable, Edge also supports a bounded generic JSON/JSONL
event-log shape and explicitly selected vendor-audit formats. Those lanes can
provide actor, action, resource, and destination evidence, but they do not
manufacture missing causal parentage.

---

## What we need, in order of importance

### Tier 0. Required for the OTLP path

| Attribute | Why we need it | What happens if missing |
|---|---|---|
| `trace_id` | Basic OTel span identity | Span ignored entirely |
| `span_id` | Same | Same |

Every OTLP exporter emits these by default. If you're not emitting them, your collector pipeline is broken upstream of Provenex.

### Tier 1. Strongly required (span typing: the engine reads ONE of these)

The most reliable way for Provenex to know what a span IS (tool call vs chat vs retrieval vs agent invocation). Emit **one** of these on every relevant span:

| Telemetry shape | Attribute the engine reads natively |
|---|---|
| OTel-GenAI (canonical) | `gen_ai.operation.name` ∈ {`chat`, `execute_tool`, `retrieval`, `invoke_agent`, other supported operations} |
| OpenInference / Phoenix | `openinference.span.kind` ∈ {`LLM`, `TOOL`, `RETRIEVER`, `AGENT`, `CHAIN`, `EMBEDDING`} |
| LangSmith | `langsmith.span.kind` |
| LangFuse | `langfuse.observation.type` |
| OpenLLMetry / Traceloop | `traceloop.span.kind` |
| Vercel AI SDK / Mastra | Span name patterns (`ai.toolCall`, `ai.streamText`, `ai.generateText`, `ai.embed`); auto-normalized |
| mcp-agent Python SDK | Auto-normalized to canonical tool URI shapes |
| Datadog dd-trace-py | `_dd.llmobs.span_kind`; needs the converter supplied in the evaluation kit |
| AWS Bedrock InvokeAgent | TracePart structure; needs a converter step |

If representative captures contain one of these shapes and preserve the
required identifiers, the standard normalizer can type them. Verify the actual
export; installing a framework package does not by itself enable telemetry.

#### Don't have any of these?

Provenex still tries to type spans via attribute-based fallback:

- `url.full` / `http.url` → typed as a URL resource; it may become an egress
  candidate when classification and lineage support that conclusion
- `gen_ai.agent.name` → `agent://<name>`
- `gen_ai.tool.name` → `tool://<name>`
- Heuristic fingerprinting for retrieval-shaped spans

Fallback typing degrades confidence. When most receipts remain opaque or
unclassified, Provenex reports `partial_evaluable` with an adapter gap; it must
not present the file as fully evaluated.

### Tier 2. Strongly recommended (closes catch confidence + cross-batch)

Each of these unlocks a specific catch class. Order matters; first ones first.

| Attribute | Catch class it unlocks |
|---|---|
| `parent_span_id` (clean OTel parent chains) | **Closure walker can resolve in-trace lineage in one pass.** Without it the engine falls back to five inferred recovery mechanisms: sibling inference, cross-emitter stitching, cross-batch document-ID rejoin, per-receipt risk accumulation, and request-order inference for generic event logs. These degrade confidence and are not enforcement-grade substitutes for true parentage. |
| `gen_ai.tool.name` | Tool-name catalog classification (e.g. `tool://send_email` → external-egress, `tool://lookup_customer` → privileged-pii). Without it, classification falls to span-name heuristics. |
| `gen_ai.tool.call.arguments`, `.result` | **Payload-token cross-receipt linking.** The same identifier appearing in two agents' tool arguments creates an `AsyncLink` edge and can catch cross-agent async handoff (Salesforce Agentforce / M365 Copilot / n8n workflow apps). |
| `gen_ai.data_source.id` | Source identity propagation; used for both zone classification and **cross-batch document.id rejoin** (delayed-exfil patterns, patient-attacker shape). |
| `enduser.id` (or `user.id` / `gen_ai.user.id`) | **Actor identity** for Phase B risk accumulation across sessions. Required for cross-agent sticky-risk propagation. Phase D (cross-agent fan-out catching the "Alice's ChatGPT activity elevates her in-house agent") needs this. |
| `gen_ai.agent.name` | Agent topology; drives latent-attack-path BFS. Without it, the latent path enumerator can still surface topology, but agent attribution is `agent://<service.name>`. |
| `service.name` | Multi-service deployments; disambiguates two agents under the same `agent.name`. |
| `service.namespace`, `deployment.environment`, `cloud.region`, `k8s.cluster.name`, `k8s.namespace.name`, `k8s.deployment.name` | Composite workload identity. Edge stamps `provenex.workload.id` for a concrete workload and `provenex.workload.family` for rollups, so same-named services in different environments do not collapse. |
| `data.zone` on tool spans (SDK-emitted) | **Trust-zone hint on the span itself**, alongside the `trust_zones.yaml` resolver. Values are kebab-case: `untrusted-external`, `internal`, `privileged-pii`, `external-egress`, `privileged-action`. It is honored only from a `service.name` listed under `sdk_zone_authorities`, can raise suspicion or suppress a framework catch-all, and never overrides an independently riskier PII/egress/untrusted classification. Because it is self-reported, it caps confidence at `Inferred`. See the reference tool wrapper before emitting it. |
| `provenex.action.context.*` on a pre-action output and its evidence lineage | Action-scoped environment and authorization evidence for selected secret reads, public writes, sends, execution, deployments, migrations, and IAM mutations. These attributes are honored only from authenticated workloads listed separately under `action_context_authorities`; never trust them merely because a client supplied an allowlisted `service.name`. |

### Tier 3. High-fidelity signals (vendor-specific: pass through automatically)

If your stack carries these, the engine surfaces them as first-class signals. None are required, but each one lights up specific catches when present:

| Attribute | Source | What it does |
|---|---|---|
| `provenex.copilot.xpia_detected` | M365 Copilot UAL | EchoLeak (CVE-2025-32711) signature; the high-fidelity post-fix flag |
| `provenex.copilot.jailbreak_detected` | M365 Copilot UAL | Jailbreak classifier signal |
| `provenex.copilot.bing_grounding` | M365 Copilot UAL | Marks Bing-web-grounded interactions |
| `bedrock.guardrail.action = INTERVENED` | AWS Bedrock | Bedrock Guardrails caught content |
| `provenex.chatgpt.identity_synthetic` | OpenAI organization audit log | Marks synthesized vs. real user identity (service accounts vs. real humans) |
| `provenex.delegation.scope` | Multi-agent delegation | Delegation-scope mismatch policy |
| `provenex.document.id` | Cross-batch correlation | Same document id across batches = cross-time lineage edge |
| `provenex.crossbatch.origin` | Auto-stamped by engine | (Engine produces this; don't emit it yourself.) |

---

## Pre-flight check before evaluation

Before pointing a live exporter at the customer-local edge, sanity-check the
telemetry shape:

```bash
# Run the packaged scanner locally; no customer bytes leave the machine.
provenex-scan discover your-trace.otlp.json
```

Or import an approved file into the direct customer-local receiver generated
during installation and inspect its response headers and local report:

```bash
curl -i -X POST "$PROVENEX_EDGE_INGEST_URL" \
  -H "Authorization: Bearer $PROVENEX_INGEST_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @your-trace.otlp.json

curl -fsS \
  -H "Authorization: Bearer $PROVENEX_EDGE_API_TOKEN" \
  http://127.0.0.1:18080/report
```

The protocol-correct success body is `{}`. The
`x-provenex-receipts-ingested` response header carries the normalized receipt
count and `x-provenex-custody: customer-local` asserts the custody boundary;
neither claims a verdict. The local report carries evaluated egress and
coverage.

- If `x-provenex-receipts-ingested` is 0, inspect `ingest_outcome` for an empty,
  unsupported, or parsed-zero input.
- If receipts ingest but `ingest_outcome.egress_points_seen` is 0, no protected
  action or egress candidate was found in the normalized receipts. Confirm the
  exporter includes the relevant tool, HTTP, or action spans.
- If egress is assessed but no Red finding appears, the flow may be clean, but
  missing classification, unknown action semantics, broken lineage, or dropped
  telemetry can also suppress a finding. Inspect `can_evaluate_exfil`, warnings,
  and `not_evaluable_reasons`; do not infer coverage from Green alone.

---

## What we DON'T need

- **Prompt content at the central scorer.** The customer-local Edge reconstructs
  lineage and builds the bounded closure; the hosted scorer evaluates only that
  minimized closure. Prompts and tool bodies may remain in the local workspace
  when the customer's own policy permits, but they are not fields in the
  scoring DTO and must never appear in **Data boundary → Your data**.
- **Custom instrumentation.** If your existing OpenTelemetry / framework instrumentation isn't enough, the gap is usually a missing OTLP exporter on your collector, not a Provenex requirement.
- **A trust_zones.yaml at signup.** The engine auto-classifies via the heuristic discovery overlay. You can author one later to tune classifications; the trial works without it.

---

## What unlocks specific catches

If you want a particular catch class to fire, here's the minimum:

| Catch | Minimum telemetry |
|---|---|
| **Cross-zone composition** (a primary catch class in the checked-in reconstruction pack) | Tier 0 + Tier 1 plus reconstructable lineage |
| **Latent attack path enumeration** (the day-1 onboarding finding) | Tier 0 + Tier 1 + multiple tool spans per agent |
| **Delayed exfil** (patient-attacker; write Monday, exfil Friday) | Above + `gen_ai.data_source.id` AND/OR `provenex.document.id` |
| **Cross-agent risk propagation** (Phase D. Alice's ChatGPT elevates her in-house agent) | Above + `enduser.id` consistent across sources |
| **Trust-zone drift** (vendor changes its tool catalog under you) | Above + customer signs off on `trust_zones.yaml` (we snapshot at first observation) |
| **Honest-mistake archetypes** (intent-blind; non-prod to prod, cross-tenant, etc.) | Legacy examples require customer-confirmed resource classifications and reviewed rules. Selected deploy, IAM, and migration controls use trusted `provenex.action.context.*` emitted by an authenticated `action_context_authority`. Narrative `provenex.source.*` fixture annotations do not unlock a catch. |
| **EchoLeak XPIA signature** (CVE-2025-32711) | M365 Copilot UAL ingestion (we emit `provenex.copilot.xpia_detected`) |

---

## Framework cheat sheet

Common frameworks and their out-of-box telemetry shape; useful for confirming where your collector should look.

| Framework | Default shape | Default OTel-GenAI compatible? |
|---|---|---|
| LangChain (with `opentelemetry-instrumentation-langchain` or LangSmith→OTLP) | OpenInference + custom langchain spans | Yes |
| LangGraph | OpenInference + langgraph metadata | Yes |
| OpenAI Responses API / Agents SDK | Direct API calls or built-in Agents SDK traces sent to OpenAI by default; OTel/OpenInference only through separately configured instrumentation or a trace processor | Partial; qualify the actual exported schema before import |
| Anthropic SDK direct | Manual + `anthropic-instrumentation` (community) | Partial; depends on collector config |
| Vercel AI SDK / Mastra | Vendor span names (`ai.toolCall`, etc.); auto-normalized | Yes (auto-normalization landed) |
| smolagents | OpenInference | Yes |
| Mastra | Vendor span names; auto-normalized | Yes |
| AWS Bedrock Agents | TracePart structure | Needs converter (auto-converted by ingestor) |
| Azure OpenAI / Microsoft Copilot Studio | Application Insights → OTel exporter | Yes |
| Datadog LLM Observability (dd-trace) | `_dd.llmobs.*` | Needs converter |
| LangFuse / Phoenix | Native (OpenInference under the hood) | Yes |

If your framework is not listed, import an approved sample into the local
workspace and share the qualification summary, not the raw trace.

---

## Common gotchas

1. **`gen_ai.input.messages` and `gen_ai.output.messages` carry JSON-stringified arrays, not flat strings.** Both shapes work but the JSON shape is what enables payload-token extraction (cross-agent linking). Modern instrumentation emits JSON.
2. **`parent_span_id` is empty on root spans.** That's expected (every trace has one root). The engine handles roots correctly; the recovery mechanisms only engage when an intermediate span has missing/broken parent links.
3. **LangChain → OpenAI SDK does not always propagate context cleanly.** The chat span can look like a sibling, not a child, of the agent invocation. Provenex's cross-emitter LLM stitcher handles this; you don't need to fix it client-side.
4. **Sampling can break lineage, and fully dropped traces are silent.** If a
   sampler drops some spans, Provenex can often surface dangling links and
   degrade confidence. If tail sampling drops the whole trace, there is no
   dangling edge for the engine to observe. Configure complete capture for
   protected agent/action paths where feasible and reconcile collector
   receive/export counts before treating zero Reds as evidence of safety.
5. **Sensitive content in resource URIs.** If your `gen_ai.data_source.id` is
   `outlook://mailbox/alice@acme.com/inbox/…`, the raw value remains in the
   customer-local receipt store. The scorer receives only its customer-keyed
   HMAC token. Apply local retention/redaction controls as needed and verify the
   exact outbound DTO in **Data boundary → Your data** before enforcement.

---

## We will tell you if something's off

Successful Edge imports update the customer-local report, whose
machine-readable `ingest_outcome` names what the received telemetry can
support. Transport or format rejections return an explicit non-2xx response
and must not be read as Green. Report/scan outcomes include:

- `evaluable` or `evaluable_with_warnings`: the engine produced a usable
  assessment; read every warning and capability flag.
- `partial_evaluable`: useful evidence was ingested, but a load-bearing signal
  such as egress identity, parentage, or resource mapping is missing.
- `not_agentic`: only bare chat/LLM telemetry was present; there was no action
  chain to compose.
- `empty_payload`, `parsed_zero_receipts`, or `unsupported_format`: the upload
  was not evaluated. Fix the named reason rather than reading it as Green.
- `internal_error`: processing failed; no coverage claim is valid.

The same object includes `not_evaluable_reasons`, warnings, recommended next
steps, receipt and egress counts, and capability flags. A fully sampled-out
trace cannot appear in this response because Edge never received it; validate
collector delivery separately.

---

## Quick links

- [Onboarding guide](onboarding.md)
- [Install the customer-local edge](install.md)
- [Data activity ingest contract](data-activity-ingest.md)
- [What Provenex cannot see](what-provenex-cannot-see.md)
- [Evaluation architecture](../README.md)

## If you run SaaS agents only (no in-house agent code)

Most teams start here: coding assistants (ChatGPT, Claude, Copilot) and
sales/GTM agents (Apollo, Artisan, Agentforce), with no agent code of their
own to instrument. Telemetry from these platforms is AUDIT-EVENT shaped,
not span-shaped: strong user identity, per-action records, but no causal
chains and no egress spans. Here is what that buys today and how to get more.

### OpenAI API Platform organization audit logs today

- **Explicit local import available:** select the browser's legacy **ChatGPT
  Enterprise** label, or use `format=chatgpt` on the private vendor-audit
  listener. The accepted shape is the OpenAI API Platform organization
  audit-log envelope from `GET /v1/organization/audit_logs`. It contains
  management-plane user actions and configuration changes; it is not a feed of
  ChatGPT conversations, model messages, GPT usage, connector calls, or tool
  execution. The customer still owns collection; Provenex does not poll it.
- **Current ChatGPT Compliance Logs are an adapter gap:** the append-only
  Compliance Logs Platform and its current conversation-message schema are a
  different product and wire format. Do not upload that export as
  `format=chatgpt` or interpret a coincidental JSON parse as evaluated coverage.
- **Not provable from audit events alone:** end-to-end exfil chains (no
  parent links to walk). Verdicts stay honestly labeled as inferred or
  not covered rather than silently green.
- **To get more:** route assistant egress (actions/connectors that leave
  your tenant) through the Provenex egress proxy so destinations become
  visible and enforceable.

### Claude today

- **Claude Code:** optional distributed traces are a beta feature with separate
  trace flags from its metrics and event/log exporters. Send only the trace
  signal to the Edge and qualify the beta span schema before claiming coverage.
- **Claude API / Claude Enterprise:** supported Compliance exports can use the
  explicitly selected `anthropic` vendor-audit format. They have the same
  audit-shape limits as ChatGPT above. If your team
  builds anything on the Claude API, one
  instrumentation library (OpenLLMetry or OpenInference) upgrades you to full
  chain telemetry.

### Sales/GTM SaaS agents (Apollo, Artisan, Agentforce, and similar)

- **Where a local adapter exists:** the operator explicitly selects its
  supported audit/activity shape for customer-local import. The local report
  can provide inventory and latent-composition findings such as who can read
  CRM data and send external email; it cannot invent missing causal edges.
- **Agentforce specifically:** session-tracing events use Salesforce's own
  schema and remain roadmap work. The supported Salesforce Event Monitoring
  shape has direct selected import. Do not claim the separate Agentforce
  Session Tracing schema unless that exact schema has been qualified.
- **To get the most:** (1) keep the scheduled audit/activity export in a
  customer-controlled drop and run the reviewed local adapter, (2) put outbound
  email/webhook egress behind the proxy where the platform allows custom
  SMTP/relay or webhook endpoints, (3) ask us for the adapter request
  bundle if your platform's export is not recognized. Delivery time depends on
  the schema and whether semantic mapping alone is sufficient or new transport
  code is required.

### Knowledge/search agents (Glean and similar)

Glean-class assistants sit on connectors into your most sensitive corpora
(Drive, Slack, Jira, tickets), making their audit logs a high-value candidate.
Native Glean CSV has no adapter or packaged converter today, so do not claim
findings from that file until a reviewed local mapping exists. If a future
converter produces canonical OTLP, the same audit-shape and egress-visibility
limits will apply.

### The general rule

Import one supported export customer-locally using an explicitly selected
format. If the file is not recognized, Provenex reports the adapter gap instead
of pretending it was evaluated. Detection Readiness then states what the
normalized telemetry supports and which instrumentation or routing change
unlocks the next class.

## How to export audit logs from your SaaS agent platforms

Concrete, verified steps per platform: whether the telemetry exists by
default or an admin must turn it on, what plan it is gated on, and how to
get the export out.

**Current Edge/UI boundary:** `/v1/traces` accepts canonical OTLP and the
documented generic event-log shape. When an authenticated Edge advertises HTTP
ingest, **Import telemetry history** also offers ten explicitly selected native
audit formats: Slack Enterprise, ChatGPT Enterprise, Google Workspace, GitHub,
Salesforce, Okta, AWS Bedrock, Microsoft 365 Copilot, Anthropic, and Shopify.
Those files are posted directly to `/v1/vendor-audit?format=...`; they are not
converted to OTLP. **ChatGPT Enterprise** is a legacy selector label for the
OpenAI API Platform organization audit-log shape; it does not denote support
for current ChatGPT Compliance Logs.

The private ingest listener supports the formats advertised by
`GET /v1/capabilities`, authenticated with `PROVENEX_INGEST_API_TOKEN`.
`data-activity` is the documented
[sensor-neutral metadata contract](data-activity-ingest.md). The caller selects
the format; Edge does not sniff arbitrary dumps. Glean native CSV remains
unsupported. None of these upload paths provides live vendor API polling,
OAuth, pagination, cursors, or scheduled backfill.

### OpenAI organization audit logs and ChatGPT Compliance Logs

These are separate products with separate schemas.

#### OpenAI API Platform organization audit log — supported file shape

The OpenAI API Platform's
[organization audit-log API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/audit_logs)
lists user actions and configuration changes. Collect its paginated
`GET /v1/organization/audit_logs` response with the required OpenAI
administrative credential, retain it under the customer's policy, and import
that unmodified `object: "list"` envelope using the browser's legacy
**ChatGPT Enterprise** selector or `format=chatgpt`.

The adapter normalizes management-plane event identity, actor/session/API-key
identity, and organization/project context when present. It does not turn that
feed into conversation, prompt, model, connector, or tool-call telemetry.

#### ChatGPT Enterprise Compliance Logs — not yet supported

**Availability:** OpenAI documents the Compliance Platform for Enterprise and
Edu workspaces. The authenticated
[Admin API reference](https://chatgpt.com/admin/api-reference) is the source of
truth for current roles, access, routes, schemas, filters, and request behavior.

How to export:

1. Confirm access and the required administrator role in the authenticated
   Admin API reference.
2. Use the immutable, append-only compliance log stream for continuous
   collection. Consult the current reference for any supported stateful
   resources rather than copying a route from this guide.
3. Retain exported records under the customer's own policy. OpenAI documents a
   30-day Compliance Logs Platform retention window, so source retention does
   not replace the customer's archive or legal-hold process.

The legacy stateful conversations route was removed on June 5, 2026; use the
current conversation log system. See OpenAI's
[Compliance API guide](https://learn.chatgpt.com/docs/enterprise/compliance-api)
and [Compliance Platform overview](https://help.openai.com/en/articles/9261474-compliance-api-for-chatgpt-enterprise-edu-and-chatgpt-for-teachers).

**With Provenex today:** current Compliance Logs, including the current
conversation-message log schema, need a schema-checked adapter and fixture.
They are not supported by `format=chatgpt`. Keep them customer-side until that
adapter is qualified; Provenex does not poll the Compliance API.

### Claude (Anthropic)

Two separate paths: admin audit logs and Claude Code telemetry.

**Claude Enterprise audit logs. Default or opt-in:** recorded for
Enterprise organizations (not available on Team); no enable step is
documented, but verify visibility in your admin console.

1. As an Organization Owner or Primary Owner, open Organization
   settings > Data and Privacy.
2. Click Export logs. All audit logs from the past 180 days are
   aggregated.
3. Watch for the email with a download link (active for 24 hours). Events can
   also be streamed to SIEM tooling via Anthropic's Compliance API. For
   Enterprise organizations using customer-managed encryption keys, the UI
   export button is unavailable; use the Compliance API.
4. Note: chat and project titles/content are not included, only their
   identifiers.

**Claude Code OpenTelemetry export. Default or opt-in:** opt-in via
environment variables; available wherever Claude Code runs.

1. Set `CLAUDE_CODE_ENABLE_TELEMETRY=1` and
   `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`.
2. Set `OTEL_TRACES_EXPORTER=otlp` and
   `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf`.
3. Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the provisioned Edge
   `/v1/traces` URL and add the ingest-only authorization header. Do not route
   the metrics or logs/events signals to `/v1/traces`.
4. Fleet-wide: put the same `env` block in Claude Code's managed
   settings file so every developer exports without per-user setup.

**With Provenex:** qualify Claude Code's beta trace schema against the standard
trace path before claiming coverage. Its metrics are not trace input, and its
OTLP events/logs require a reviewed log-to-supported-event adapter. Supported
Anthropic Compliance exports can use the explicitly selected `anthropic`
vendor-audit format; audit records may lack end-to-end causal lineage. See
[Anthropic's current monitoring documentation](https://code.claude.com/docs/en/monitoring-usage).

### Glean

**Default or opt-in:** admin audit logs appear in the Admin Console
without a documented enable step; Glean's docs do not state plan
gating, so verify in your admin console that your plan includes them.

1. In the Glean Admin Console, go to Users & permissions > Audit logs.
2. Filter by date, actor, or action, then click Export to CSV (all log
   fields included: timestamps, identities, actions, affected
   resources, change details).
3. Default retention is 30 days; longer windows require contacting your
   Glean representative, so schedule regular exports.
4. For Glean-hosted deployments, ongoing delivery of audit logs and Customer
   Event logs to a customer-managed destination can be configured through the
   Glean account team. It is not a default or self-serve connector.
5. Note: admin audit logs cover admin actions. End-user search and
   assistant activity is surfaced separately; verify in your admin
   console which activity exports your plan includes.

**With Provenex:** native Glean CSV is not supported by the current Edge or
adapter library. Keep the export customer-side; a reviewed mapping/conversion is
integration work before it can be imported.

### Microsoft Copilot (Purview audit)

**Default or opt-in:** on by default for Microsoft 365 enterprise
tenants. Copilot interactions are logged automatically under Audit
(Standard), included in enterprise licenses; no extra Copilot-specific
configuration is needed. Two exceptions: auditing is NOT on by default
for SMB licenses (Business Basic/Standard/Premium), and interactions
with non-Microsoft AI apps (record types `AIAppInteraction` /
`ConnectedAiAppInteraction`) require enabling Purview pay-as-you-go
billing.

1. Confirm auditing is on for the tenant (Purview portal > Audit, or
   `Get-AdminAuditLogConfig | FL UnifiedAuditLogIngestionEnabled` in
   Exchange Online PowerShell).
2. In the Microsoft Purview portal, select Audit and search with
   operation name `CopilotInteraction` (related record types:
   `CopilotInteraction`, `ConnectedAIAppInteraction`,
   `AIAppInteraction`).
3. Export search results to CSV from the same screen.
4. For a continuous feed, pull via `Search-UnifiedAuditLog` in Exchange
   Online PowerShell or subscribe via the Office 365 Management
   Activity API.
5. Retention: 180 days on Audit (Standard); Audit (Premium / E5) and
   retention policies extend to a year or more. Records include
   `AccessedResources` (with sensitivity label IDs) and the
   `XPIADetected` flag.

**With Provenex:** supported Purview/UAL-shaped exports use the explicitly
selected `m365` format and map the high-fidelity signals listed in Tier 3.
Import support does not imply Provenex collects from Purview or that every
record contains an outbound action.

### Salesforce Agentforce

**Default or opt-in:** opt-in. Agentforce Session Tracing must be
toggled on by an admin and requires Data Cloud provisioned and Einstein
enabled; only conversations AFTER enablement are traced. Plain event
log files exist more broadly, but full Event Monitoring is gated on the
Salesforce Shield (or standalone Event Monitoring) add-on.

1. In Setup, find the Agentforce Session Tracing setting and toggle it
   On (prerequisites: Data Cloud fully provisioned, Einstein on,
   both Einstein Generative AI and Agentforce enabled, and Salesforce Standard
   Data Model v1.130 or higher).
2. Traces land in Data Cloud as Session Tracing Data Model objects;
   query or export them from Data Cloud. Session tracing consumes Data
   Cloud credits, so review the billing considerations page first.
3. For audit-shaped events, download hourly or daily Event Log Files as
   CSV (Event Log File Browser or the API). Retention and event
   coverage depend on whether you have the Shield / Event Monitoring
   add-on; verify in your admin console.
4. Schedule the export; a daily file drop is enough to start.

**With Provenex:** supported Event Monitoring exports use the explicitly
selected `salesforce` format. Do not claim Agentforce Session Tracing schema
coverage unless that exact schema has been separately qualified.

---

Facts above were re-checked August 2026 against vendor documentation.
Vendors change plan gating, retention windows, and console layouts;
re-check your admin console before relying on a specific limit.

### Continuous monitoring (not just one-time exports)

The how-tos above produce a file; monitoring should not stop there:

- **Live span sources** (Claude Code OTel, traditional services, and your own
  agents): point the existing OTel Collector's OTLP/HTTP exporter at the local
  edge `/v1/traces` receiver with the local bearer token. Keep existing APM
  exporters in the same pipeline.
- **Audit-log sources:** schedule collection into a customer-controlled
  location, then use browser import or the private vendor-audit listener for
  explicitly supported formats. This is file/direct ingest, not a live
  connector. Unsupported formats remain an adapter gap; Glean native CSV is
  still unsupported.
- **Native vendor pollers** (Provenex pulling Compliance, Purview, or Glean APIs
  centrally): not shipped. Do not give central staging a vendor credential as a
  workaround.
