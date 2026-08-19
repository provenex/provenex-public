# Provenex Check CLI

`provenex-check` is a small, public collector and client for the hosted
Provenex analysis service. It does not contain, import, download, or execute a
local Provenex analysis engine.

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
subcommand the CLI defaults to `scan .`; starting with an option such as
`--dry-run` does the same.

Uploads need a Provenex trial API key (`--dry-run` needs none). Request a trial
key at [provenex.ai](https://provenex.ai) — it is a bounded trial tenant — and
set it as `PROVENEX_API_KEY` before a real scan.

Developers can instead run from a verified source checkout of this repository
(`npm test && npm link`, or `node ./bin/provenex-check.js` directly).

## First run

Inspect what would leave the laptop. This reads no API key and sends nothing:

```sh
provenex-check scan /path/to/project --dry-run
```

Add `--discover-ai-history` to opt in to bounded discovery under the well-known
Claude Code and Codex session directories. Discovery parses only the first
complete JSONL metadata record, bounded to 64 KiB per candidate, and selects a
session only when that record's provider-specific `cwd` exactly matches the
canonical scan root. Malformed, missing, and over-limit first records are
skipped. Only bytes through the first record count toward the 32 MiB aggregate
metadata budget. Discovery then lists the selected count and bytes in the
preflight. It never reads browser history, cookies, or authentication stores,
and never runs unless the flag is present. Discovery fails closed rather than
returning partial selection if the combined Claude/Codex traversal would
exceed 10,000 directories, 100,000 directory entries, 20,000 candidate session
files, or 32 MiB of first-record metadata.

Then create an owner-only report directory and run a check:

```sh
mkdir -m 700 "$HOME/provenex-reports"
export PROVENEX_API_KEY='replace-with-your-key'
provenex-check scan /path/to/project \
  --json "$HOME/provenex-reports/check.json" \
  --html "$HOME/provenex-reports/check.html"
```

The CLI asks for interactive approval. Automation must add `--yes`; otherwise
a non-interactive upload fails closed. Production API keys are never accepted
on the command line and are eligible only for the pinned production origin. As
an alternative to the production environment variable, store this JSON in
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
approval and key loading—but before any request—it also rejects selected source
or artifact content containing the exact active bearer or its JSON-escaped
representation. That diagnostic is redacted. `--dry-run` still reads no API
key.

## Telemetry-assisted checks

`scan` accepts explicitly selected session history and dependency audit output.
`audit` adds runtime/log/cost evidence. Repeat any artifact option as needed:

```sh
provenex-check audit /path/to/project \
  --session-input /path/to/session.jsonl \
  --fly-log /path/to/fly.jsonl \
  --cloudwatch-log /path/to/cloudwatch.json \
  --aws-input /path/to/cost-and-usage.json \
  --dependency-audit /path/to/npm-audit.json
```

Artifact contents are uploaded only after they appear in the preflight and the
user approves. Artifacts receive opaque deterministic labels such as
`session-001.jsonl`; local filenames and paths are not sent as artifact
metadata. `scan` and `audit` share the same transparent upload contract; the
command tells the service which analysis depth the user requested.

For `--session-input`, ordinary Claude Code, Cursor, Codex, or other agent
session files must use the supported JSONL input form. A file whose exact
basename is `conversations.json` is treated as a supported ChatGPT or Claude
web conversation export; the private engine content-discriminates the export
and it receives the opaque label `conversation-export-001.json`. Other
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
- Credential-bearing project files such as `.envrc`, `.dev.vars`,
  `credentials`, `.npmrc`, `.pypirc`, `.netrc`, `.dockercfg`,
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
  artifact, and 64 MiB total. Requests are capped at 8 consent categories;
  user overrides are capped at 10,000 files, 4 MiB per source file, 256 artifacts
  (including at most 32 AWS-cost and 32 dependency-audit artifacts), 64 MiB per
  artifact, and 64 MiB total.
  Separately, the serialized JSON request is refused above the service's
  128 MiB body cap.
- The bounded upload plus receipt of response headers has a 30-minute total
  deadline, suitable for the 128 MiB request ceiling. A successful streamed
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

The JSON output is the complete validated public response, including an opaque
safe `service_release`, the exact applied policy, and the signed public report.
HTML is generated locally from that same report. The response-provided
ephemeral public key verifies envelope self-consistency only: it does not
establish Provenex issuer identity, server authenticity, or durable
attestation. HTTPS and API authentication remain the transport and account
boundary.
