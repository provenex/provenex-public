# Provenex Check CLI

`provenex-check` is a small, public collector and client for the hosted
Provenex analysis service. It does not contain, import, download, or execute a
local Provenex analysis engine.

This package has two deliberately disjoint halves. The CLI documented below is
a one-shot, consent-first collector a person runs. The
[runtime action checkpoint](#runtime-action-checkpoint-provenexcheckcheckpoint)
is a library your server imports from `@provenex/check/checkpoint` to ask the
Provenex App gateway for a decision before a consequential action runs. The
CLI never loads the checkpoint module and the checkpoint never loads the
collector; a test pins the two import graphs apart.

The CLI selects relevant UTF-8 source/configuration files and user-selected
telemetry, prints the exact upload origin and a byte/category preflight, asks
for consent, and calls `POST /v1/check/runs`. The service returns a strict,
bounded public report DTO in an ephemeral per-run signature envelope. The CLI
validates that DTO, its exact applied data policy, its canonical bytes, and its
Ed25519 self-consistency signature before rendering terminal or HTML views
locally. Server-rendered views and private engine fields are rejected.

## Requirements and installation

- Node.js 22 or newer
- A Provenex API key for uploads (`--dry-run` needs no key)

Install the scoped package from npm, or run it without installing:

```sh
npm install -g @provenex/check
provenex-check --version
```

`npx @provenex/check <args>` runs the same CLI without a global install. With no
arguments it inventories the current project locally. Starting with a scan
option such as `--dry-run` defaults to `scan .`.

Uploads need a Provenex trial API key (`--dry-run` needs none). Request a trial
key at [provenex.ai](https://provenex.ai), which issues a bounded trial tenant,
then set it as `PROVENEX_API_KEY` before a real scan.

A worked source-only example on four public GitHub repositories (what `plan`
showed, what the scan flagged, and how to read each finding) is in
[`docs/check-cli-oss-case-study.md`](../../docs/check-cli-oss-case-study.md).
The smallest tree to try first is
[`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers).

Developers can instead run from a verified source checkout of this repository
(`npm test && npm link`, or `node ./bin/provenex-check.js` directly).

## First run

See one complete public example, inspect what is on disk without uploading,
then inspect what would leave the laptop. None of these commands reads an API
key or sends anything:

```sh
provenex-check demo
provenex-check plan /path/to/project
provenex-check capabilities
provenex-check scan /path/to/project --dry-run
```

Add `--list-files` to the dry run when you want every selected
source-relative path instead of the compact default preflight.

On an interactive TTY, `scan` and `audit` first run bounded, metadata-only
discovery under the well-known Claude Code and Codex session directories. The
CLI reports `found`, `none`, or `unavailable`. When it finds exact-project
matches, it asks once, with a default of yes, whether to include the full session
files for an unjoined review alongside the project scan. This version does not
yet connect a session action to a source path. Declining leaves every session
out. The broader trace/export/audit-file catalog stays collapsed behind a
separate, default-no “Add another evidence file?” question. Paths entered at
that prompt are read inside the CLI; the CLI does not write them to shell
history.

Metadata discovery parses only the first complete JSONL record, bounded to 64
KiB per candidate, and matches only when that record's provider-specific `cwd`
equals the canonical scan root exactly. Malformed, missing, and over-limit
first records are skipped. Only bytes through the first record count toward the
32 MiB aggregate metadata budget. The preflight lists the included session
count and bytes, never their filenames. Discovery never reads browser history,
cookies, or authentication stores. Discovery fails closed rather than returning
a partial selection if the combined Claude/Codex traversal would exceed 10,000
directories, 100,000 directory entries, 20,000 candidate session files, or 32
MiB of first-record metadata.

Non-interactive runs, `--yes`, and `--no-prompt` do not perform this guided
discovery and never include local AI history by themselves. Use
`--discover-ai-history` as the explicit inclusion flag for automation or when
skipping prompts. `--yes` approves the displayed upload only; it is not consent
to search or collect AI history.

Then create an owner-only report directory and run a check:

```sh
mkdir -m 700 "$HOME/provenex-reports"
export PROVENEX_API_KEY='replace-with-your-key'
provenex-check scan /path/to/project \
  --json "$HOME/provenex-reports/check.json" \
  --html "$HOME/provenex-reports/check.html"
```

The CLI asks for interactive approval. On a TTY, `scan` and `audit` first
perform the metadata-only AI-history check described above. The optional file
offer follows only if requested. The CLI then prints the complete upload
preflight and calls `POST /v1/check/runs` once. Automation must add `--yes`;
`--no-prompt` skips only the guided discovery and file offer, so a
non-interactive upload without `--yes` still fails closed. Production API keys
are never accepted on the command line and are eligible only for the pinned
production origin. As an alternative to the production environment variable,
store this JSON in
`~/.config/provenex/check.json` and run `chmod 600` on the file:

```json
{ "api_key": "replace-with-your-key" }
```

For a loopback development endpoint, set only a disposable local test token:

```sh
export PROVENEX_CHECK_DEV_API_KEY='local-test-token'
provenex-check scan /path/to/synthetic-project \
  --api-url http://127.0.0.1:8787
```

Loopback never reads `PROVENEX_API_KEY` or the production config file. Its
preflight labels the endpoint non-production: do not submit real sensitive
evidence or production credentials. The local server must still emulate and
return the exact `provenex-check-ephemeral-v1` applied policy or the CLI rejects
its response.

The canonical home directory itself is not an eligible scan root; select a
project subtree. Provenex, Codex, and Claude credential stores are always
excluded when a broader eligible target contains them, including a custom
`XDG_CONFIG_HOME`. Known Claude/Codex AI-history roots are pruned from generic
source traversal. The CLI does not display or upload those local paths. After
approval and key loading, but before any request, it also rejects selected source
or artifact content containing the exact active bearer or its JSON-escaped
representation. That diagnostic is redacted. `--dry-run` still reads no API
key.

## Telemetry-assisted checks

`scan` accepts explicitly selected session history, runtime traces, and
dependency audit output. `audit` adds runtime/log/cost evidence. Repeat any
artifact option as needed:

```sh
provenex-check scan /path/to/project \
  --telemetry /path/to/otel-traces.json \
  --session-input /path/to/session.jsonl \
  --dependency-audit /path/to/npm-audit.json \
  --dry-run

provenex-check audit /path/to/project \
  --session-input /path/to/session.jsonl \
  --telemetry /path/to/otel-traces.json \
  --fly-log /path/to/fly.jsonl \
  --cloudwatch-log /path/to/cloudwatch.json \
  --aws-input /path/to/cost-and-usage.json \
  --dependency-audit /path/to/npm-audit.json
```

`--telemetry` defaults to OpenTelemetry JSON (`--telemetry-format otel`). The
hosted engine reduces consented traces to receipts and scores reachable
compositions. It also accepts native Langfuse `{trace, observations}` JSON,
LangSmith REST Run / `/runs/query` arrays, and LangChain OpenLLMetry /
OpenInference OTLP on that same default. GitHub org or enterprise audit-log
JSON needs `--telemetry-format github` (or a TTY offer that sniffs the
shape). That is not GitHub Actions job logs; workflow YAML is already in
the source scan. ChatGPT Enterprise audit logs use `--telemetry-format
chatgpt`; chat bodies belong in a `conversations.json` `--session-input`.
AWS Bedrock model-invocation logs use `--telemetry-format bedrock` (or the
same sniff) and may be a CloudWatch `FilterLogEvents` JSON export or a JSON
array of `ModelInvocationLog` records. The public report may include a Next evidence
section for missing parent links, tool payloads, or identity; it does not
return private scoring rules or attack-path names.

Artifact contents are uploaded only after they appear in the preflight and the
user approves. Artifacts receive opaque deterministic labels such as
`session-001.jsonl`; local filenames and paths are not sent as artifact
metadata. `scan` and `audit` share the same transparent upload contract; the
command tells the service which analysis depth the user requested.

For `--session-input`, ordinary Claude Code, Cursor, Codex, or other agent
session files must use the supported JSONL input form. A file whose exact
basename is `conversations.json` is treated as a supported ChatGPT or Claude
web conversation export; the hosted service identifies the supported export
from its content, and it receives the opaque label
`conversation-export-001.json`. Other
arbitrary `.json` files are rejected rather than silently interpreted as
JSONL. The local basename is used only for this routing decision and is not
sent to the API. A broad source scan always excludes any case variant of the
basename `conversations.json`; a web export is eligible only through exact,
explicit
`--session-input`, which classifies it as `ai_session_history` in the preflight.
Other artifact flags cannot relabel a web conversation export.

## Collection and safety boundary

- `.git`, dependency trees, compiler/build outputs, coverage, and vendor
  directories are excluded by default.
- Directory symlinks and file symlinks are never followed.
- Only a maintained list of code, configuration, manifest, lock, and
  environment text files is selected; `.env`, `.env.*`, and every `*.env`
  suffix (for example `prod.env`) is classified as
  `environment_secrets`. Invalid UTF-8 and over-limit inputs fail closed.
- Generic configuration is a high-sensitivity upload category because JSON,
  YAML, TOML, and similar files can contain credentials or customer data. The
  exact high-sensitivity path list remains limited to recognized
  credential-bearing names.
-   Credential-bearing project files such as `.envrc`, `.dev.vars`,
  `credentials`, AWS `*accessKeys.csv` / `*_credentials.csv` console
  downloads, `.npmrc`, `.pypirc`, `.netrc`, `.dockercfg`,
  `.dockerconfigjson`, `.terraformrc`, and `.yarnrc` are deliberately selected
  and shown as high-sensitivity paths before consent. The allowlist also covers
  common native/mobile build files and text formats including CSV, HTML, TXT,
  Gradle, Bazel, Make, Xcode configuration, and project files.
- Known Provenex, Codex, and Claude credential stores are excluded before
  source selection when they lie under an eligible target, and cannot be
  explicitly selected as artifacts. Known Claude/Codex session-history roots
  are pruned from generic traversal; discovery and explicit `--session-input`
  are the consented routes. Other artifact flags cannot relabel files beneath
  those roots. Local protected paths are never shown or uploaded.
- Defaults are 5,000 source files, 1 MiB per source file, 16 MiB per telemetry
  artifact, and 64 MiB total. Requests are capped at 12 consent categories;
  user overrides are capped at 10,000 files, 4 MiB per source file, 256 artifacts
  (including at most 32 AWS-cost, 32 dependency-audit, and 32 telemetry artifacts), 64 MiB per
  artifact, and 64 MiB total.
  Separately, the serialized JSON request is refused above the service's
  128 MiB body cap.
- The bounded upload plus receipt of response headers has a 30-minute total
  deadline, adjustable up to two hours with `--timeout SECONDS` or
  `PROVENEX_CHECK_TIMEOUT_MS` (milliseconds). The flag takes precedence. A successful streamed
  response is capped at 32 MiB, a 10-minute total body deadline, and a
  60-second idle deadline between chunks.
- Git state is read with non-shelling, read-only Git commands. The CLI resolves
  an absolute executable only from absolute PATH directories outside the scan
  root, excludes repo-owned shims, sanitizes Git injection variables and the
  child PATH, and disables pagers, hooks, and configured filesystem monitors.
- CLI-generated metadata never adds local absolute paths. Selected source,
  session, and log content can itself contain local paths or other secrets;
  review the high-sensitivity categories before approving an upload.
- Report files must be explicitly requested and outside the scanned tree.
  Existing files are not replaced unless `--force` is given; symlinks are
  always rejected.
- Production uploads are pinned to `https://api.provenex.ai`. `--api-url` and
  `PROVENEX_CHECK_API_URL` accept only an HTTP or HTTPS loopback origin for
  local development; arbitrary remote origins are rejected before an API key
  is read.

Use repeatable, quoted `--exclude` patterns to remove repository paths before
they are read. Patterns are repository-relative, support `*`, `?`, and `**`,
and never become part of the API request. A pattern without `/` matches that
name in any directory; a literal path also prunes its descendants. Negation,
absolute paths, backslashes, and `.`/`..` components are rejected. For example:

```sh
provenex-check scan /path/to/project --dry-run \
  --exclude '.env*' \
  --exclude '*.env' \
  --exclude 'fixtures/customer-data/**'
```

`--exclude` applies to repository collection, not to an artifact explicitly
selected with `--session-input` or another artifact flag. The preflight shows
default exclusions, local user patterns and match counts, selected
high-sensitivity source paths, and explicit artifact paths. These local paths
and patterns are not uploaded as request metadata; discovered session
filenames are never displayed or uploaded.

The production preflight labels high-sensitivity categories and states that
approved evidence goes to the central multi-tenant service. A loopback
preflight instead labels the endpoint non-production and displays the local
development warning above. Consent in either case is specifically to
[`provenex-check-ephemeral-v1`](https://github.com/provenex/provenex-public/blob/main/docs/provenex-check-data-policy.md): zero
seconds of application-scope raw-evidence and derived-result retention, a
request-only processing workspace, and workspace deletion before response.
The CLI rejects a missing, changed, or extended policy declaration. It cannot
independently prove server-side deletion; JSON and HTML files that the user
chooses to write are local copies outside that application policy.

The public schemas are in [`schemas/`](schemas/) and the endpoint description
is in [`openapi/provenex-check.v1.yaml`](openapi/provenex-check.v1.yaml).

Request v1 supports explicit public-report negotiation. Omitting
`requested_report_schema` preserves the strict `provenex-check-public-report.v1`
shape for deployed clients. The current CLI requests
`provenex-check-public-report.v2` and supplies `project_scope`, an opaque
client-authored HMAC identity matching `pvxproj-` plus 64 lowercase hex
characters. The service signs and echoes that scope so local comparisons stay
bound to the same client-defined project. It is not Provenex authority, tenant
identity, or a durable attestation. V2 `report_mode` is `joined` only when a
supported telemetry-path or cross-family business join was evaluated;
otherwise it is `source_preview`. Independent source, session, dependency, or
runtime clues do not become a joined business-risk claim merely because they
were uploaded together.

Every v2 finding includes a bounded `owner_view`: a consequence-first headline,
one business-impact lane, a detector-authored evidence sentence (or an explicit
unavailable fallback), separate `observed`, `inferred`, and `not_established`
claims, and remediation with a goal, proposed changes, and acceptance criteria. Fully authored families cover
the cross-trace composition of untrusted input, private data, and an outbound
send, plus source-level webhook authenticity. Other detectors use an explicit
fallback and do not promote their legacy evidence summary into claim-level
facts.

`owner_view.verification_key` is a stable opaque key only when a detector
authors a structural identity; otherwise it is `null` and the CLI must not
claim that absence on a later run verified a fix. `verification_family` is an
opaque detector-family identity reserved for conservative comparisons. Display
ids such as `finding-0001` remain ordinal and are never verification identities.

## Re-run verification

After making a change, compare a new `scan` with an owner-only JSON report from
the same target:

```sh
provenex-check scan /path/to/project \
  --verify-against "$HOME/provenex-reports/check.json" \
  --json "$HOME/provenex-reports/check-next.json" \
  --html "$HOME/provenex-reports/check-next.html"
```

The prior report must be a regular, owner-owned file with no group or other
permissions (`chmod 600`); symlinks are rejected. The CLI validates its strict
DTO, target, canonical bytes, and self-consistency signature before uploading
the new run. Neither the prior response nor its local path enters the hosted
request or the newly signed JSON report. The comparison exists only in local
terminal and HTML views.

Comparison outcomes are deliberately limited to `still-present` and
`not-verifiable`. V2 derives an opaque `project_scope` by applying HMAC-SHA-256
with the active Check credential to the canonical local project root; neither
the root nor the credential enters the report. The hosted response signs and
echoes that opaque scope so two same-named projects cannot be compared as one.
Moving the project or rotating its Check credential deliberately breaks the
binding. A prior key that is missing from the new report remains
`not-verifiable` because the current contract does not yet prove that the exact
candidate and evidence scope were evaluated again. Provenex Check never calls
absence “fixed.”

The JSON output is the complete validated public response, including an opaque
safe `service_release`, the exact applied policy, and the signed public report.
HTML is generated locally from that same report. CLI report outputs and their
temporary files are created owner-only. The response-provided
ephemeral public key verifies envelope self-consistency only: it does not
establish Provenex issuer identity, server authenticity, or durable
attestation. HTTPS and API authentication remain the transport and account
boundary.

## Runtime action checkpoint (`@provenex/check/checkpoint`)

The runtime half of this package wraps one consequential side effect (a
refund, an export, an outbound email) with a pre-action decision from the
tenant-scoped Provenex App gateway. It is plain ESM with no build step and no
dependencies: the code npm installs is the code you read, plus a hand-authored
`types/checkpoint.d.ts` that a test pins to the runtime exports.

```js
import { ProvenexCheckpoint, ProvenexBlockedError } from "@provenex/check/checkpoint";

const checkpoint = new ProvenexCheckpoint({
  gatewayUrl: "https://app-sandbox.provenex.ai",
  apiKey: process.env.PROVENEX_SDK_KEY, // tenant-scoped pvx_sdk_ workload key
  mode: "shadow",                        // observe | shadow | prevent
});

await checkpoint.guard({ action, scoreClosure }, async () => {
  await issueRefund(order);              // runs only when the decision allows
});
```

The operating modes are a deliberate ramp. `observe` and `shadow` never
withhold the operation; `shadow` additionally records a verified would-block.
`prevent` withholds on a verified block and is registration-paired to
`failMode: "closed"`, so an unreachable gateway stops the action rather than
silently allowing it. The pairing is enforced at construction because the
gateway refuses any other registration. Every request has one bounded timeout
(default 2 seconds), no retry, no redirect, and no cache; retrying a decision
must never become retrying a side effect, so put financial and message-send
actions behind a durable idempotent outbox.

The checkpoint sends only an already HMAC-minimized score-closure envelope.
It never accepts raw prompts, bodies, destinations, receipt ids, or the HMAC
secret, and tenant and policy identity come only from the workload key, never
from caller-supplied fields.

### Tenant Guard helpers

`tenantRelation`, `tenantRelationMarkerKey`, and `tenantRelationMarker`
compute the one Tenant Guard fact that may enter `closure.nodes[].signals`:
whether the requesting subject's application tenant and the touched resource's
owner tenant were equal, keyed by the deployed `tenant-match` rule's id. The
comparison is exact bytes and runs in your process; neither tenant identifier
belongs in the envelope and the hosted Engine never receives one. Resolve both
values from trusted state (the session and the row), never from caller input:
the deployed rule fails closed when the marker is absent, so an unstamped path
is a coverage gap rather than a clear.

### Workspace coverage (`provenex-check coverage`)

```sh
export PROVENEX_SDK_KEY='pvx_sdk_...'
provenex-check coverage --gateway-url https://your-app-gateway.example
```

Asks YOUR App gateway what it can prove about your workspace right now and
renders it verbatim: the decision lane this key is registered on, connector
health, and durable action custody (counts by state, oldest unsettled
action). The gateway's honesty rule travels with the data: connected is
credentials, not coverage, and absent areas are "not evaluated", never safe.
The key is read from the environment only; keys are never CLI arguments.

### Owner brief (`provenex-check brief`)

Accepted App design partners can configure the gateway origin in the
environment and ask for the server-authored priorities in human or agent form:

```sh
export PROVENEX_APP_GATEWAY_URL='https://your-app-gateway.example'
export PROVENEX_SDK_KEY='pvx_sdk_...'

provenex-check brief
provenex-check brief --format json
```

The text view contains only what needs action, why, and the next step. JSON is
a strict schema-versioned projection written to standard output without a
prompt or ANSI controls. Unknown fields are discarded before output. The
gateway composes the action list from workspace-scoped facts; this public CLI
does not contain or run detectors, policies, or prioritization logic.

The command is read only. It cannot approve, retry, release, or execute an
action. An empty action list means only that the areas evaluated by this brief
produced no owner action; connected remains credentials rather than coverage,
and absent areas remain not evaluated, never safe. See the
[App owner brief](../../docs/app-owner-brief.md) for credential handling and a
bounded agent instruction.

Provision a separate key with `brief:read` for an owner or general-purpose AI.
Add `coverage:read` only if it also needs the coverage command. Legacy
`decide` keys remain accepted by the gateway for compatibility, but must not be
given to a morning-brief agent.

### What this half proves, and what it does not

Only wrapped call sites are controlled. The honest claim is that routed
actions were checked, not that the provider is protected: code that reaches a
provider without passing the checkpoint is invisible to it. The alpha does not
yet implement local signing, durable outbox state, approval release, or
receipt upload.

### Explaining a decision (`provenex-check explain`)

Every checkpoint result can be saved as JSON and explained offline:

```sh
provenex-check explain decision.json --signer-key <64-hex Ed25519 public key>
```

`explain` accepts a checkpoint result, a gateway decision, an Engine
assessment, or a bare signed verdict. When the artifact carries its exact
signed canonical bytes, the verdict section renders FROM those bytes, so what
you read is what was signed, and any disagreement with the convenience view is
flagged. With `--signer-key` it checks the Ed25519 signature; without it, it
says plainly that the signature was not checked. It never re-canonicalizes a
reconstructed artifact to make a signature pass, it renders per-policy
coverage (fired, cleared, gap, not applicable) alongside the findings, and it
ends with what the artifact does not prove: only a PEP-signed enforcement
receipt shows an action was actually withheld or allowed at a boundary.
Nothing is uploaded.
