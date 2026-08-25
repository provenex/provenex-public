# Telemetry-assisted Provenex Check

The current public telemetry path is an explicit `--telemetry` input to the
hosted Provenex Check CLI. The selected file appears in the upload preflight and
is sent only after approval. The website does not accept telemetry or browser
files, and no public Edge receiver is available.

## Start with a dry run

```sh
npx @provenex/check scan /path/to/project \
  --telemetry /path/to/otel-traces.json \
  --dry-run
```

The preflight identifies the telemetry category, local path, format, size, and
total request bounds. A real upload requires `PROVENEX_API_KEY` and interactive
approval, or `--yes` in automation.

## Minimum OpenTelemetry shape

For each relevant span, provide:

- a valid `trace_id` and `span_id`;
- `service.name` or equivalent workload identity;
- `parent_span_id` or OpenTelemetry links when causal context exists;
- an operation or span-kind field that identifies chat, agent, retrieval, tool,
  HTTP, or RPC activity; and
- action, resource, actor, and destination fields available from the emitting
  framework.

Missing identity or parentage does not become a clean result. The public report
can mark the telemetry partial and request the next evidence needed.

## Recognized span typing

The hosted service accepts canonical OpenTelemetry and common adjacent shapes:

| Source shape | Useful fields |
|---|---|
| OTel GenAI | `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.data_source.id` |
| OpenInference / Phoenix | `openinference.span.kind` plus standard trace identity |
| LangSmith | native REST Run arrays or normalized OpenTelemetry |
| Langfuse | native `{trace, observations}` JSON or normalized OpenTelemetry |
| OpenLLMetry / Traceloop | `traceloop.span.kind` plus standard trace identity |
| Vercel AI SDK / Mastra | emitted AI span names plus standard trace identity |
| HTTP and RPC/gRPC | method, route/service, peer or destination, status, and propagated trace context |

Framework installation alone does not establish coverage. Inspect a
representative exported file and confirm that it contains the operations and
causal context you expect the report to evaluate.

## Fields that improve the result

| Field | Public effect |
|---|---|
| `parent_span_id` and OTel links | Connects observed steps inside a trace |
| `gen_ai.tool.name` | Names the action or tool consistently |
| `gen_ai.tool.call.arguments` and `.result` | May connect supported handoffs; review and redact under your data policy |
| `gen_ai.data_source.id` | Gives a stable source identity when the emitter provides one |
| `enduser.id`, `user.id`, or `gen_ai.user.id` | Supports actor continuity across supplied evidence |
| `gen_ai.agent.name` | Supports agent attribution |
| `service.name`, namespace, environment, region, and workload fields | Distinguishes same-named services and deployments |
| HTTP/RPC URL, peer, service, method, and status fields | Makes destinations and action outcomes observable |

Do not invent identifiers or classifications merely to satisfy the table. A
stable value derived by the source system is more useful than a guessed value
added during export.

## Explicit telemetry formats

`--telemetry` defaults to `otel`. The CLI accepts these explicit format names
and aliases:

- `otel`, `otlp`, `otel-genai`, `langfuse`, `langsmith`, `langchain`;
- `chatgpt` or `openai` for OpenAI API Platform organization-management audit
  logs, not conversation content or current ChatGPT Compliance Logs;
- `okta`;
- `bedrock` or `aws`;
- `m365`, `copilot`, or `m365-copilot`;
- `anthropic` or `anthropic-compliance`;
- `gws`, `google`, or `google-workspace`;
- `github` for GitHub organization or enterprise audit logs, not Actions job
  logs;
- `salesforce` or `sfdc`;
- `slack`, `slack-audit`, or `slack-enterprise`;
- `mcp`;
- `shopify`; and
- `data-activity` or `data_activity` for the documented
  [sensor-neutral contract](data-activity-ingest.md).

Select a format explicitly when the file is not canonical OpenTelemetry:

```sh
npx @provenex/check scan /path/to/project \
  --telemetry /path/to/bedrock-model-invocation.json \
  --telemetry-format bedrock \
  --dry-run
```

Interactive evidence selection can recognize bounded OpenTelemetry, Langfuse,
LangSmith, GitHub audit, OpenAI organization audit, and Bedrock shapes. Treat
that prompt as a convenience, not permission to submit an arbitrary JSON file.

## What a file adapter does not provide

A supported format means the hosted service can parse a selected file under the
public Check contract. It does not mean Provenex:

- connects to the vendor account;
- owns an OAuth grant or administrative credential;
- paginates or backfills an API;
- verifies that an export is complete or fresh; or
- continuously monitors the source.

Collect exports under the source vendor's current instructions and your own
retention policy. Glean native CSV and current ChatGPT Compliance Logs are not
supported telemetry formats in the public CLI.

## Sampling and missing evidence

- A sampled-out span or missing parent can break a causal path.
- A successful parse establishes only that the supplied records were accepted.
- Audit events often show actors and actions but no end-to-end parentage.
- Post-action telemetry can support retrospective analysis; it does not prove
  that the action was held or blocked.
- A zero-finding report over partial telemetry is not an all-clear for omitted
  runtime activity.

Use the report's coverage and next-evidence fields to decide whether another
trace, session, identity source, dependency audit, runtime log, or cost export
would materially improve the result.

## Related input paths

- Use `--session-input` for explicitly selected supported AI-session JSONL or a
  supported `conversations.json` export.
- Use `--dependency-audit` for supported package-audit JSON produced separately.
- Use `audit --fly-log`, `--cloudwatch-log`, and `--aws-input` for explicit
  runtime and cost exports.

The exact selection bounds, protected paths, exclusions, consent behavior, and
format options are maintained in the
[CLI reference](../cli/provenex-check/README.md). Coverage interpretation is in
[coverage semantics](what-provenex-cannot-see.md).
