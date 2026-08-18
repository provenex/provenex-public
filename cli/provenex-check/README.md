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

From this directory:

```sh
npm install
npm link
provenex-check --version
```

For a published package, use `npm install --global provenex-check` or
`npx provenex-check --help`.

Running `npx provenex-check` with no subcommand defaults to `scan .`. Starting
with an option (for example, `npx provenex-check --dry-run`) does the same.

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
and never runs unless the flag is present. Discovery stops at 10,000
directories, 100,000 directory entries, 20,000 candidate session files, or
32 MiB of first-record metadata—whichever comes first.

Then create an owner-only report directory and run a check:

```sh
mkdir -m 700 "$HOME/provenex-reports"
export PROVENEX_API_KEY='replace-with-your-key'
provenex-check scan /path/to/project \
  --json "$HOME/provenex-reports/check.json" \
  --html "$HOME/provenex-reports/check.html"
```

The CLI asks for interactive approval. Automation must add `--yes`; otherwise
a non-interactive upload fails closed. API keys are never accepted on the
command line. As an alternative to the environment variable, store this JSON
in `~/.config/provenex/check.json` and run `chmod 600` on the file:

```json
{ "api_key": "replace-with-your-key" }
```

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
sent to the API.

## Collection and safety boundary

- `.git`, dependency trees, compiler/build outputs, coverage, and vendor
  directories are excluded by default.
- Directory symlinks and file symlinks are never followed.
- Only a maintained list of code, configuration, manifest, lock, and `.env`
  text files is selected; invalid UTF-8 and over-limit inputs fail closed.
- Credential-bearing project files such as `.envrc`, `.dev.vars`,
  `credentials`, `.npmrc`, `.pypirc`, `.netrc`, `.dockercfg`,
  `.dockerconfigjson`, `.terraformrc`, and `.yarnrc` are deliberately selected
  and shown as high-sensitivity paths before consent. The allowlist also covers
  common native/mobile build files and text formats including CSV, HTML, TXT,
  Gradle, Bazel, Make, Xcode configuration, and project files.
- Defaults are 5,000 source files, 1 MiB per source file, 16 MiB per telemetry
  artifact, and 64 MiB total. User overrides are capped at 10,000 files, 4 MiB
  per source file, 256 artifacts, 64 MiB per artifact, and 64 MiB total.
  Separately, the serialized JSON request is refused above the service's
  128 MiB body cap.
- Git state is read with non-shelling, hook-disabled read-only Git commands.
- CLI-generated metadata never adds local absolute paths. Selected source,
  session, and log content can itself contain local paths or other secrets;
  review the high-sensitivity categories before approving an upload.
- Report files must be explicitly requested and outside the scanned tree.
  Existing files are not replaced unless `--force` is given; symlinks are
  always rejected.
- HTTPS is mandatory except for a loopback development server.

Use repeatable, quoted `--exclude` patterns to remove repository paths before
they are read. Patterns are repository-relative, support `*`, `?`, and `**`,
and never become part of the API request. A pattern without `/` matches that
name in any directory; a literal path also prunes its descendants. Negation,
absolute paths, backslashes, and `.`/`..` components are rejected. For example:

```sh
provenex-check scan /path/to/project --dry-run \
  --exclude '.env*' \
  --exclude 'fixtures/customer-data/**'
```

`--exclude` applies to repository collection, not to an artifact explicitly
selected with `--session-input` or another artifact flag. The preflight shows
default exclusions, local user patterns and match counts, selected
high-sensitivity source paths, and explicit artifact paths. These local paths
and patterns are not uploaded as request metadata; discovered session
filenames are never displayed or uploaded.

The preflight labels high-sensitivity categories and states that approved
evidence goes to the central multi-tenant service. Consent is specifically to
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
