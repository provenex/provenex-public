# Telemetry checklist: what to emit for best results

A short, actionable checklist for customers integrating Provenex. Tiered by how much catching power each piece unlocks. Most customers using a modern agent framework (LangChain, LlamaIndex, OpenAI Assistants, Anthropic SDK, LangGraph, Mastra) emit enough of this **by default** to get full value; but the checklist makes it explicit so security teams can verify before running an eval.

## TL;DR: minimum viable telemetry

If you can answer **yes** to these three, you're ready to send Provenex your telemetry and see real Red verdicts:

- [ ] Your agent emits OpenTelemetry traces (any of the listed shapes below)
- [ ] Each span carries `trace_id` and `span_id`
- [ ] The chain of `parent_span_id` from the agent's output back to its inputs is reconstructable

Almost any modern agent framework with OpenTelemetry instrumentation passes this bar. **If you're not sure, just send us a sample trace; we'll run it through `provenex-scan` and tell you what's in it.**

---

## What we need, in order of importance

### Tier 0. Required (engine can't ingest at all without these)

| Attribute | Why we need it | What happens if missing |
|---|---|---|
| `trace_id` | Basic OTel span identity | Span ignored entirely |
| `span_id` | Same | Same |

Every OTLP exporter emits these by default. If you're not emitting them, your collector pipeline is broken upstream of Provenex.

### Tier 1. Strongly required (span typing: the engine reads ONE of these)

The most reliable way for Provenex to know what a span IS (tool call vs chat vs retrieval vs agent invocation). Emit **one** of these on every relevant span:

| Telemetry shape | Attribute the engine reads natively |
|---|---|
| OTel-GenAI (canonical) | `gen_ai.operation.name` ∈ {`chat`, `execute_tool`, `retrieval`, `invoke_agent`, . .} |
| OpenInference / Phoenix | `openinference.span.kind` ∈ {`LLM`, `TOOL`, `RETRIEVER`, `AGENT`, `CHAIN`, `EMBEDDING`} |
| LangSmith | `langsmith.span.kind` |
| LangFuse | `langfuse.observation.type` |
| OpenLLMetry / Traceloop | `traceloop.span.kind` |
| Vercel AI SDK / Mastra | Span name patterns (`ai.toolCall`, `ai.streamText`, `ai.generateText`, `ai.embed`); auto-normalized |
| mcp-agent Python SDK | Auto-normalized to canonical tool URI shapes |
| Datadog dd-trace-py | `_dd.llmobs.span_kind`. needs a converter step (`tools/blind_corpus/convert_dd_to_otlp.py`) |
| AWS Bedrock InvokeAgent | TracePart structure; needs a converter step |

If your SDK already emits one of these, you're done; no manual instrumentation needed. **If you're using LangChain / LlamaIndex / LangGraph and your collector is configured to OTLP, this is automatic.**

#### Don't have any of these?

Provenex still tries to type spans via attribute-based fallback:

- `url.full` / `http.url` → typed as the URL resource directly (egress spans get caught this way)
- `gen_ai.agent.name` → `agent://<name>`
- `gen_ai.tool.name` → `tool://<name>`
- Heuristic fingerprinting for retrieval-shaped spans

Fallback degrades catch confidence from `Confirmed` to `Inferred`, but **does not** make the engine non-functional. **The only true failure is when ≥80% of spans fall through to `span://<hex>` with no kind attribute**. at that point we tell you "the customer needs an adapter" with a specific error and don't pretend to evaluate.

### Tier 2. Strongly recommended (closes catch confidence + cross-batch)

Each of these unlocks a specific catch class. Order matters; first ones first.

| Attribute | Catch class it unlocks |
|---|---|
| `parent_span_id` (clean OTel parent chains) | **Closure walker can resolve in-trace lineage in one pass**. Without it the engine falls back to 4 recovery mechanisms; still works but slower + degrades confidence. |
| `gen_ai.tool.name` | Tool-name catalog classification (e.g. `tool://send_email` → external-egress, `tool://lookup_customer` → privileged-pii). Without it, classification falls to span-name heuristics. |
| `gen_ai.tool.call.arguments`, `.result` | **Payload-token cross-receipt linking**. same identifier appearing in two agents' tool args creates an `AsyncLink` edge, catches cross-agent async handoff (Salesforce Agentforce / M365 Copilot / n8n workflow apps). |
| `gen_ai.data_source.id` | Source identity propagation; used for both zone classification and **cross-batch document.id rejoin** (delayed-exfil patterns, patient-attacker shape). |
| `enduser.id` (or `user.id` / `gen_ai.user.id`) | **Actor identity** for Phase B risk accumulation across sessions. Required for cross-agent sticky-risk propagation. Phase D (cross-agent fan-out catching the "Alice's ChatGPT activity elevates her in-house agent") needs this. |
| `gen_ai.agent.name` | Agent topology; drives latent-attack-path BFS. Without it, the latent path enumerator can still surface topology, but agent attribution is `agent://<service.name>`. |
| `service.name` | Multi-service deployments; disambiguates two agents under the same `agent.name`. |
| `data.zone` on tool spans (SDK-emitted) | **Authoritative trust-zone declaration on the SPAN itself**, in addition to the `trust_zones.yaml` URL-pattern resolver. Values are kebab-case: `untrusted-external`, `internal`, `privileged-pii`, `external-egress`, `privileged-action`. When the SDK declares this, it WINS over any URL-pattern catch-all (`tool://*` → internal, `model://*` → internal, etc.) that would otherwise classify the span as infrastructure noise. Without it, framework wrapper spans + LLM-call spans collapse to `tool://*` / `model://*` catch-alls and get classified as internal-data sources, which over-fires `internal-egress` on every LLM-driven agent reply. With it, the engine knows which calls operate on real internal data vs. which are framework transformations. Stamp it in your tool wrapper at span creation; ask us for the reference wrapper implementation. |

### Tier 3. High-fidelity signals (vendor-specific: pass through automatically)

If your stack carries these, the engine surfaces them as first-class signals. None are required, but each one lights up specific catches when present:

| Attribute | Source | What it does |
|---|---|---|
| `provenex.copilot.xpia_detected` | M365 Copilot UAL | EchoLeak (CVE-2025-32711) signature; the high-fidelity post-fix flag |
| `provenex.copilot.jailbreak_detected` | M365 Copilot UAL | Jailbreak classifier signal |
| `provenex.copilot.bing_grounding` | M365 Copilot UAL | Marks Bing-web-grounded interactions |
| `bedrock.guardrail.action = INTERVENED` | AWS Bedrock | Bedrock Guardrails caught content |
| `provenex.chatgpt.identity_synthetic` | ChatGPT Enterprise audit | Marks synthesized vs. real user identity (service accounts vs. real humans) |
| `provenex.delegation.scope` | Multi-agent delegation | Delegation-scope mismatch policy |
| `provenex.document.id` | Cross-batch correlation | Same document id across batches = cross-time lineage edge |
| `provenex.crossbatch.origin` | Auto-stamped by engine | (Engine produces this; don't emit it yourself.) |

---

## Pre-flight check before evaluation

Before pointing your traces at Provenex's trial endpoint, sanity-check your telemetry shape:

```bash
# Pipe a sample OTLP/JSON file from your collector to scan locally
curl https://provenex.ai/static/preflight.sh | bash -s your-trace.otlp.json
# (roadmap: script is the wrapper around `provenex-scan` that produces
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

- Your trace has no egress-shaped spans. Provenex needs at least one `execute_tool` or `http`-shaped destination span to evaluate against. Confirm your collector is exporting tool / HTTP spans, not just LLM chat spans.

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
| **Cross-zone composition** (the headline catch; every published breach) | Tier 0 + Tier 1 + a clean `parent_span_id` chain OR the 4 fallback recovery mechanisms |
| **Latent attack path enumeration** (the day-1 onboarding finding) | Tier 0 + Tier 1 + multiple tool spans per agent |
| **Delayed exfil** (patient-attacker; write Monday, exfil Friday) | Above + `gen_ai.data_source.id` AND/OR `provenex.document.id` |
| **Cross-agent risk propagation** (Phase D. Alice's ChatGPT elevates her in-house agent) | Above + `enduser.id` consistent across sources |
| **Trust-zone drift** (vendor changes its tool catalog under you) | Above + customer signs off on `trust_zones.yaml` (we snapshot at first observation) |
| **Honest-mistake archetypes** (intent-blind; non-prod to prod, cross-tenant, etc.) | Above + customer-side attributes that mark provenance (`provenex.source.scope`, `provenex.source.tenant`, etc.; emit at instrumentation time) |
| **EchoLeak XPIA signature** (CVE-2025-32711) | M365 Copilot UAL ingestion (we emit `provenex.copilot.xpia_detected`) |

---

## Framework cheat sheet

Common frameworks and their out-of-box telemetry shape; useful for confirming where your collector should look.

| Framework | Default shape | Default OTel-GenAI compatible? |
|---|---|---|
| LangChain (with `opentelemetry-instrumentation-langchain` or LangSmith→OTLP) | OpenInference + custom langchain spans | Yes |
| LlamaIndex (with `llama-index-instrumentation-otel`) | OpenInference | Yes |
| LangGraph | OpenInference + langgraph metadata | Yes |
| OpenAI Assistants (with `openai-instrumentation`) | OpenInference | Yes |
| Anthropic SDK direct | Manual + `anthropic-instrumentation` (community) | Partial; depends on collector config |
| Vercel AI SDK / Mastra | Vendor span names (`ai.toolCall`, etc.); auto-normalized | Yes (auto-normalization landed) |
| smolagents | OpenInference | Yes |
| Mastra | Vendor span names; auto-normalized | Yes |
| AWS Bedrock Agents | TracePart structure | Needs converter (auto-converted by ingestor) |
| Azure OpenAI / Microsoft Copilot Studio | Application Insights → OTel exporter | Yes |
| Datadog LLM Observability (dd-trace) | `_dd.llmobs.*` | Needs converter |
| LangFuse / Phoenix | Native (OpenInference under the hood) | Yes |

If your framework isn't listed, **send us a sample trace**. we'll tell you what's in it and what's missing.

---

## Common gotchas

1. **`gen_ai.input.messages` and `gen_ai.output.messages` carry JSON-stringified arrays, not flat strings.** Both shapes work but the JSON shape is what enables payload-token extraction (cross-agent linking). Modern instrumentation emits JSON.
2. **`parent_span_id` is empty on root spans**. that's expected (every trace has one root). The engine handles roots correctly; the recovery mechanisms only engage when an intermediate span has missing/broken parent links.
3. **LangChain → OpenAI SDK does NOT propagate context cleanly**. the chat span looks like a sibling, not a child, of the agent invocation. Provenex's cross-emitter LLM stitcher handles this; you don't need to fix it client-side.
4. **Sampling will break you.** If your collector is configured to sample 10% of traces, Provenex sees a 10% subset and the closure walker can miss the cross-batch hops. Provenex is the consumer that needs **100% sampling**. If you can't do 100% globally, configure your sampler to send 100% of GenAI traces.
5. **Sensitive content in resource URIs.** If your `gen_ai.data_source.id` is `outlook://mailbox/alice@acme.com/inbox/. .`, then "Alice's email" reaches Provenex inside the resource URI. The hash-only mode redacts content fields but NOT resource URIs (because those drive classification). Either (a) hash the local-part client-side before instrumentation, or (b) use the `provenex-ingest` forwarder's redaction patterns when the per-customer pattern flag ships (on the roadmap; the field list is fixed today).

---

## We will tell you if something's off

Every Provenex scan emits a **Step-0 qualification verdict** that names what the engine could and couldn't evaluate:

- `Evaluable`. telemetry has the shape the engine can walk; full catch surface eligible
- `PartialEvaluable`. spans parsed but resources unresolved; **needs an adapter or a missing kind attribute**
- `BareLlm`. no structural shape to evaluate (just chat spans, no tools); per-prompt classifiers are the right tool here
- `NotEvaluableAdapterEmpty`. zero receipts produced; check that the body is OTLP JSON
- `NotEvaluableAdapterMissing`. ≥80% of receipts fell to `span://<hex>` synthetic IDs; tell us your framework

These appear in `/v1/receipts` responses (a dashboard surface for them is on the roadmap); for now, use `provenex-scan` against a sample file locally to get the full readout before integration.

---

## Quick links

- [Onboarding guide](onboarding-trial.md)
- [Open-source ingest proxy (hash mode)](ingest-proxy.md)
- [What the engine catches and why](how-provenex-catches.md)
- [The full architectural reference](../README.md) (§"What telemetry Provenex expects")

## If you run SaaS agents only (no in-house agent code)

Most teams start here: coding assistants (ChatGPT, Claude, Copilot) and
sales/GTM agents (Apollo, Artisan, Agentforce), with no agent code of their
own to instrument. Telemetry from these platforms is AUDIT-EVENT shaped,
not span-shaped: strong user identity, per-action records, but no causal
chains and no egress spans. Here is what that buys today and how to get more.

### ChatGPT (Enterprise) today

- **Out of the box:** we ingest the ChatGPT Enterprise Compliance/audit
  export with a native adapter. You get: who used which tools/GPTs against
  which connectors, latent risky tool combinations (sensitive read +
  external send capability in one assistant), and a Detection Readiness
  report saying exactly what is provable.
- **Not provable from audit events alone:** end-to-end exfil chains (no
  parent links to walk). Verdicts stay honestly labeled as inferred or
  not covered rather than silently green.
- **To get more:** route assistant egress (actions/connectors that leave
  your tenant) through the Provenex egress proxy so destinations become
  visible and enforceable.

### Claude today

- **Claude Code:** native OpenTelemetry export (opt-in env vars). This is
  real span telemetry; point it at your collector and Provenex ingests it
  directly. Best-supported SaaS coding agent today.
- **Claude API / Claude Enterprise:** admin audit logs only; same
  audit-shape support and limits as ChatGPT above. If your team builds
  anything on the Claude API, one instrumentation library (OpenLLMetry or
  OpenInference) upgrades you to full chain telemetry.

### Sales/GTM SaaS agents (Apollo, Artisan, Agentforce, and similar)

- **Out of the box:** audit/activity exports from these platforms ingest
  via the audit-event path where an export exists. You get inventory and
  latent-composition findings: which agents can read CRM data AND send
  external email, who triggered what, sequence-level anomalies
  (export-then-send patterns).
- **Agentforce specifically:** session-tracing events are richer than
  plain audit logs but use Salesforce's own schema; a native adapter is on
  our roadmap, and audit exports work today.
- **To get the most:** (1) send us the platform's audit/activity export on
  a schedule (a daily file drop is enough to start), (2) put outbound
  email/webhook egress behind the proxy where the platform allows custom
  SMTP/relay or webhook endpoints, (3) ask us for the adapter request
  bundle if your platform's export is not recognized: we turn unknown
  formats into adapters quickly and the bundle tells us exactly what to map.

### Knowledge/search agents (Glean and similar)

Glean-class assistants sit on connectors into your most sensitive corpora
(Drive, Slack, Jira, tickets) and can act on them, which makes them the
highest-value audit-log source we ingest. We model these the same way as
other SaaS agents: audit events in, latent cross-corpus exposure paths and
permission-drift findings out; chain-level proof requires egress
visibility, same as above.

### The general rule

Run one scan on whatever export you have today. The report's Detection
Readiness section tells you, per detection class, what your current
telemetry supports and the exact instrumentation or routing change that
unlocks the next class. You never have to guess what to instrument.

## How to export audit logs from your SaaS agent platforms

Concrete, verified steps per platform: whether the telemetry exists by
default or an admin must turn it on, what plan it is gated on, and how to
get the export out.

### ChatGPT Enterprise (OpenAI Compliance API)

**Default or opt-in:** Opt-in. Workspace activity is logged, but API
access to it (the Compliance API / Compliance Logs Platform) must be
explicitly enabled for your workspace by OpenAI. Enterprise and Edu
plans; not available on Team.

How to export:

1. As a user who is an Owner of both the OpenAI organization AND the
   ChatGPT Enterprise workspace, create an API key in the OpenAI
   Platform (Owned by: You; Permissions: All). It is shown once; store
   it securely.
2. Confirm the Organization ID in your Platform API settings matches the
   organization of the ChatGPT workspace, and note your `workspace_id`
   from the ChatGPT admin console under Workspace details.
3. Email support@openai.com to request Compliance API access. Include
   the last 4 characters of the key, the key name, who created it, and
   the scope you want (read, write, or both).
4. Pull conversations, uploaded files, admin actions, auth events, and
   agent activity as JSON from the Compliance API. The Compliance Logs
   Platform retains 30 days, so schedule a recurring pull and keep your
   own archive.

**With Provenex:** we have a native ChatGPT Enterprise audit adapter;
point your scheduled pull at us (or drop the JSON files) and the
audit-shape findings described earlier in this section light up.

### Claude (Anthropic)

Two separate paths: admin audit logs and Claude Code telemetry.

**Claude Enterprise audit logs. Default or opt-in:** recorded for
Enterprise organizations (not available on Team); no enable step is
documented, but verify visibility in your admin console.

1. As an Organization Owner or Primary Owner, open Organization
   settings > Data and Privacy.
2. Click Export logs. All audit logs from the past 180 days are
   aggregated.
3. Watch for the email with a download link (active for 24 hours).
   Format is JSON or CSV; events can also be streamed to SIEM tooling
   via Anthropic's Compliance API.
4. Note: chat and project titles/content are not included, only their
   identifiers.

**Claude Code OpenTelemetry export. Default or opt-in:** opt-in via
environment variables; available wherever Claude Code runs.

1. Set `CLAUDE_CODE_ENABLE_TELEMETRY=1`.
2. Set `OTEL_METRICS_EXPORTER=otlp` and `OTEL_LOGS_EXPORTER=otlp`.
3. Point `OTEL_EXPORTER_OTLP_PROTOCOL` and
   `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector (add
   `OTEL_EXPORTER_OTLP_HEADERS` if your collector needs auth).
4. Fleet-wide: put the same `env` block in Claude Code's managed
   settings file so every developer exports without per-user setup.

**With Provenex:** Claude Code OTel is real span/event telemetry and
ingests directly (best-supported SaaS coding agent today). Claude
Enterprise audit exports ingest via the audit-event path.

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
4. For continuous SIEM delivery: cloud-prem deployments expose an
   audit-log group (for example a CloudWatch log group on AWS) you can
   wire to your SIEM; for Glean-hosted, ask Glean about streaming
   options.
5. Note: admin audit logs cover admin actions. End-user search and
   assistant activity is surfaced separately; verify in your admin
   console which activity exports your plan includes.

**With Provenex:** the Glean audit shape is supported; send the CSV
export or the SIEM stream and we model it like the other SaaS agents.

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

**With Provenex:** the M365 Copilot audit feed is what powers the
high-fidelity Copilot signals listed in Tier 3 above, including the
XPIA (EchoLeak-class) detection flag.

### Salesforce Agentforce

**Default or opt-in:** opt-in. Agentforce Session Tracing must be
toggled on by an admin and requires Data Cloud provisioned and Einstein
enabled; only conversations AFTER enablement are traced. Plain event
log files exist more broadly, but full Event Monitoring is gated on the
Salesforce Shield (or standalone Event Monitoring) add-on.

1. In Setup, find the Agentforce Session Tracing setting and toggle it
   On (prerequisites: Data Cloud fully provisioned, Einstein on,
   Salesforce Standard Data Model v1.128 or higher).
2. Traces land in Data Cloud as Session Tracing Data Model objects;
   query or export them from Data Cloud. Session tracing consumes Data
   Cloud credits, so review the billing considerations page first.
3. For audit-shaped events, download hourly or daily Event Log Files as
   CSV (Event Log File Browser or the API). Retention and event
   coverage depend on whether you have the Shield / Event Monitoring
   add-on; verify in your admin console.
4. Schedule the export; a daily file drop is enough to start.

**With Provenex:** Agentforce audit/event exports work today via the
audit-event path; a native adapter for the session-tracing schema is on
our roadmap.

---

Facts above were verified June 2026 against vendor documentation.
Vendors change plan gating, retention windows, and console layouts;
re-check your admin console before relying on a specific limit.

### Continuous monitoring (not just one-time exports)

The how-tos above produce a file; monitoring should not stop there. What works today with the public provenex-ingest binary (see its built-in help for full flags):

- **Live span sources** (Claude Code OTel, your own instrumented agents): run `provenex-ingest listen --bind addr:port` as an OTLP/HTTP receiver and point your OTel Collector at it. Continuous by construction, and concurrent: any number of agents or Collectors can post to one listener (spans carry their own service and trace identity). One listener instance serves one tenant (one api key and HMAC salt); run one instance per tenant if you have several. Supports --mode hash so content is HMAC-hashed before leaving your environment.
- **Audit-log sources** (ChatGPT, Claude Enterprise, Glean, Purview, Agentforce): schedule the vendor-side export on a cron into a drop directory and run `provenex-ingest watch <dir/> --interval N` (idempotent; already-processed files are tracked). Exports need to be OTLP-shaped when dropped; recognized audit formats have converters, and the scan output names the converter when a format is detected. You get verdicts continuously at your export cadence.
- **Native vendor pollers** (Provenex pulling the Compliance API, Purview, or Glean APIs for you on a schedule, no cron on your side): not shipped yet. Email skulk@provenex.ai and we will set up live audit monitoring with you and prioritize your platform.
