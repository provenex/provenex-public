---
name: agent-decision-telemetry
description: >-
  Use when the user is shipping an AI agent, tool-using app, or vibe-coded
  workflow that emits little or no telemetry, or asks what traces, spans, or
  logs they need so later systems can reconstruct who did what, with which
  tool, to which destination. Add OpenTelemetry GenAI or an equivalent
  OpenInference, LangSmith, Langfuse, Traceloop, or Vercel AI SDK export.
  Require identity, parentage, tool names, destinations, agent, and user
  fields. Do not invent identifiers. Do not log secrets. Prefer 100 percent
  sampling on agent, tool, and egress traces.
---

# Agent decision telemetry

A baseline for apps that take consequential actions (refunds, mail, deploys,
customer data) and currently emit little or no telemetry. The point is
lineage: a later reviewer or engine should be able to reconstruct who acted,
which agent, which tool, which resource or destination, and what happened
next. This is ordinary OpenTelemetry. It is not a vendor lock-in and it is
not a claim that anything was blocked.

Copy this file into the project you are instrumenting:

- Codex and other agents: `.agents/skills/agent-decision-telemetry/SKILL.md`
- Claude Code: `.claude/skills/agent-decision-telemetry/SKILL.md`
- Cursor: `.cursor/skills/agent-decision-telemetry/SKILL.md`

## When to use this

Use this skill first when:

- the app has no tracer, no span exporter, or only stdout logs;
- traces exist but are chat-only (no tool or HTTP/RPC egress spans);
- parents are missing, so a tool call cannot be joined to the turn that
  caused it; or
- the user asks "what should we log?", "add tracing", or "is this enough
  observability for an agent?"

Do not wait for a specific vendor. Any consumer that reads OTLP, OpenInference,
LangSmith, or Langfuse can use the same fields.

## Inspect first

From the project root, look for an existing exporter before adding one:

- OpenTelemetry SDK setup (`NodeSDK`, `TracerProvider`, OTLP HTTP/gRPC)
- Framework flags: LangSmith, Langfuse, Traceloop/OpenLLMetry, Phoenix,
  Vercel AI SDK `experimental_telemetry`, OpenInference
- Env: `OTEL_EXPORTER_OTLP_ENDPOINT`, `LANGSMITH_TRACING`, `LANGFUSE_*`

If an exporter already runs, skip to **Verify a sample export**. Add only the
missing fields. Do not install a second tracer that double-counts the same
calls.

## Add instrumentation

Prefer the framework's own exporter. If none exists, add OpenTelemetry SDK
plus the matching GenAI or HTTP instrumentor for the language you are in.

Every agent run must produce more than a single chat span. At minimum emit
spans for:

1. the agent or chat turn;
2. each tool or function call;
3. each HTTP, RPC, or other egress that can move money, mail, files, or
   production state;
4. each retrieval or data-source read that later actions depend on.

Propagate trace context across those calls so non-root spans carry
`parent_span_id` (or OpenTelemetry links). Root spans have no parent. Do not
fabricate a parent.

Prefer 100 percent sampling for agent, tool, and egress traces. A sampled-out
span is invisible to every later consumer. If you cannot sample at 100 percent,
document that dropped traces cannot be reconstructed.

## Field baseline

Use the names the emitter already has. Map to OpenTelemetry GenAI semantic
conventions when you control attributes. Framework aliases are fine when they
are stable.

### Required for lineage

On every relevant span:

- `trace_id` and `span_id`
- `service.name` (resource attribute)
- `parent_span_id` or OTel links whenever this span was caused by another
- an operation kind: `gen_ai.operation.name` (chat, execute_tool, retrieval,
  invoke_agent) or the framework equivalent (`openinference.span.kind`,
  `traceloop.span.kind`, Vercel `ai.generateText` / `ai.toolCall`, HTTP/RPC
  method)

Missing identity or parentage is partial telemetry. It is not a clean result.

### Required for decision quality

Add these whenever the runtime knows them. Do not guess.

- **Action:** `gen_ai.tool.name` on every tool or function span. Aliases:
  `tool.name`, `function.name`, `ai.toolCall.name`
- **Destination or resource:** `url.full` or `http.url` / `server.address`
  plus method and status. For retrieval, `gen_ai.data_source.id`
- **Agent:** `gen_ai.agent.name` (or `agent.name`)
- **User:** `enduser.id`, else `user.id` or `gen_ai.user.id`, stable across
  services
- **Conversation or workflow:** `gen_ai.conversation.id`, or a framework
  thread/task id (`langgraph.thread_id`, protocol task ids). Do not treat a
  loose `session.id` as enough
- **Workload:** `service.namespace`, `deployment.environment`, region or
  cluster when more than one deploy exists
- **HTTP/RPC peers:** method, route or service, peer, status

### Stronger joins (data policy allowing)

Redact secrets, tokens, raw credentials, and payment instrument numbers
before export.

- `gen_ai.tool.call.id`, `.arguments`, and `.result` for supported handoffs
- stable document or chunk ids on retrieval spans
- optional content hashes when you need object continuity across sensors

Do not invent identifiers to fill a table. A missing field is more useful
than a guessed one. Do not add vendor-reserved attribute families you do not
own.

## Verify a sample export

Run one representative agent path that includes a tool call and an egress.
Write OTLP JSON, LangSmith, or Langfuse output to a local file. Confirm:

- more than chat spans are present;
- each tool and egress span has `trace_id`, `span_id`, and a parent except
  the root;
- tool spans name the tool;
- egress spans name the destination URL, peer, or data source;
- agent and user ids are stable when the app has them.

If any of those are absent, fix the emitter. Do not claim coverage from
"we installed a tracing package."

## Honesty

- Chat-only traces cannot explain a refund, send, or deploy.
- Sampling or a missing parent breaks the causal path.
- Logs without span identity are not lineage.
- Telemetry after the fact is not proof the action was held or blocked.
- Zero findings over partial telemetry is not an all-clear.

## Do not

- Log API keys, cookies, auth headers, or secrets in arguments or results
- Invent `trace_id`, conversation ids, user ids, or parent ids
- Rely on stdout print statements as the telemetry plan
- Instrument only the model call and skip tools and egress
- Point a customer exporter at an unknown third-party collector without the
  user asking
