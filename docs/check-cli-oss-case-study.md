# Check CLI on public open source (2026-08-24)

This is a worked example of `@provenex/check` on four public GitHub
repositories. We cloned HEAD on 2026-08-24, ran `plan` (no upload), then a
source-only `scan`. We did not exploit anything, did not create accounts, and
did not treat a finding as proof that a production system is compromised.

Check reports **review signals from consented evidence**, with coverage for
what was not evaluated. A source-only scan cannot score runtime agent
compositions, sessions, deploy logs, or spend. Zero findings is not an
all-clear.

SHAs are in the table below. This is a source-only snapshot, not a live
re-score of those repositories.

## Try these four

| Repository | Why it is a good first target | HEAD scanned |
|---|---|---|
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Small official MCP monorepo. Fast `plan` / dry-run. | `599dafc` |
| [withastro/astro](https://github.com/withastro/astro) | Famous CI + test-fixture `.env` files. | `8797754` |
| [dubinc/dub](https://github.com/dubinc/dub) | Solo-founder-shaped SaaS: Stripe, webhooks, Playwright. | `29df217` |
| [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev) | AI-era product: Cursor MCP, agent docs, local compose, git `.env` links. | `b082e44` |

Other public trees that also contain `pull_request_target` (we listed workflows,
we did not full-scan the whole monorepos): `n8n-io/n8n` (CLA check),
`supabase/supabase` (PR labeler), `storybookjs/storybook`.

```sh
git clone --depth 1 https://github.com/modelcontextprotocol/servers
cd servers
npx @provenex/check plan .
npx @provenex/check scan . --dry-run
```

`--dry-run` prints the exact upload preflight and reads no API key. A real
hosted scan needs `PROVENEX_API_KEY` and `--yes` in non-interactive shells.

## What `plan` showed (no file contents)

`plan` inventories surfaces. It does not read secret values.

- **servers:** TypeScript + Python, 5 GitHub workflows, 1 MCP config, 2 agent
  instruction files. Tiny tree: a 30-second first run.
- **astro:** TypeScript/JavaScript, 21 workflows, 9 environment-shaped files
  (fixture `.env*` paths), 1 agent instruction file.
- **dub:** TypeScript, 5 workflows, Vercel host hint, 1 environment-shaped file.
- **trigger.dev:** TypeScript, 35 workflows, 1 MCP config, 19 agent instruction
  files, a project `.cursor` directory (plan states Cursor databases are not
  uploaded), 4 environment-shaped files.

None of the four had an obvious OTLP filename on disk. That is the point of
`next_evidence` after a source-only scan: traces and sessions were **not
evaluated**.

## Issues we observed, and how to read them

Public report titles below match the hosted Check DTO. They are parser-free or
shape-based review signals. Several are **intentional local-dev or test
fixtures**. The useful story is that Check names them and keeps uncertainty
visible.

### 1. GitHub `pull_request_target`

**Astro** (5 workflow files). Three actually trigger on `pull_request_target`:
`label.yml`, `check-merge.yml`, and `diff-dependencies.yml`. Two others
(`ci.yml`, `scripts.yml`) only mention the token inside a concurrency
expression while the workflow itself uses `pull_request`. Check is a token
check, not a workflow interpreter. The finding text already says this does
not prove the job is exploitable.

**Dub** `apply-issue-labels-to-pr.yml` and **Trigger.dev**
`vouch-check-pr.yml` also trigger on `pull_request_target`. Trigger.dev even
comments that they never check out the PR HEAD (so fork-controlled code does
not run). That is the right follow-up: read the job. Prefer `pull_request`
unless you need base-repo permissions; if you keep `pull_request_target`, do
not check out untrusted refs before review, and keep secrets off that job.

How: open the workflow path on the finding. Confirm `on:` versus a string in
an expression. Confirm `actions/checkout` `ref`.

### 2. Environment files tracked by git

**Astro** commits four test-fixture env files under
`packages/astro/test/fixtures/` (placeholder values such as `TITLE=development`;
Check does not copy contents into the report).

**Trigger.dev** tracks five paths named `.env` that are **git symlinks** to a
local untracked `.env` (for example `apps/webapp/.env` → `../../.env`). The
destination is not in the index; the `.env` path still is. Every clone has
that path in git. Check flags the index entry, which is the rule: committed
environment paths, not “we extracted a live production secret.”

How: `git ls-files -s -- path`. Mode `120000` is a symlink. `.env.example` is
intentionally not this finding.

### 3. Literal values under password fields

**Dub** Playwright setups commit a signup password constant for MailHog tests;
CI YAML has `SMTP_PASSWORD` for the same local stack. Treat as “a password
field has a literal,” then decide if it is a test double.

Same scan also hit `packages/ui/src/input.tsx` on the accessible name “Show
Password”, and `pnpm-lock.yaml` on the npm package name `@inquirer/password`.
Those are **not credentials**. The hosted report keeps the value redacted;
you still have to read the path.

**Trigger.dev** docker-compose / helm lint values use local `POSTGRES_PASSWORD`
style literals (`postgres` in the compose file we opened). Same class:
local-dev defaults in git, not proof of a production leak.

How: open the path and line. If it is a lockfile package name, UI copy, or
documented local default, keep it as a review signal or exclude that path on
the next run.

### 4. Webhook handlers without an observed verify call

**Dub** and **Trigger.dev** both produced “no observed signature-verification
call” on files whose names or routes contain `webhook`. Several Dub hits are
UI, outbound publish, or log capture (`configure-webhook.tsx`,
`capture-webhook-log.ts`), not inbound provider intake. Trigger.dev’s hit is
an authenticated **endpoint settings** Remix route, not a Stripe-style
receiver.

How: the evidence grade is inferred. Look for `constructEvent` /
`verifySignature` / HMAC in the **same file**. If verification lives in a
helper the parser did not see, the finding is a pointer, not a verdict.
Inbound `app.post("/webhooks")` without verify is the case that deserves a
code change.

### 5. Unbounded npm selectors

**Official MCP servers** root `package.json` uses workspace-style unbounded
selectors for the in-repo server packages (four findings). **Astro** had the
same class on a React 19 test fixture package.json. This is a lockfile /
selector hygiene signal, not a CVE.

How: Check does not fetch advisories unless you pass `--dependency-audit`
JSON you generated yourself.

### What did *not* fire (also useful)

On these four trees, source-only Check did **not** emit agent auto-approve
(`alwaysAllow` / `skipPermissions` / `dangerouslyAllow*`) or unpinned `npx`
MCP launches in agent-config paths (`mcp.json`, `AGENTS.md`, `.cursor/mcp`,
`/mcp/` sources, `.mdc`).

Trigger.dev **documents** `"command": "npx"` in
`packages/cli-v3/src/commands/install-mcp.ts` (installer help text). That file
is not on the agent-config path set, so it does not become an unpinned-MCP
finding. Their committed `.cursor/mcp.json` uses an HTTP MCP URL instead.
That is a coverage boundary to know when you read a report, not a claim that
npx never appears in the product.

## What this scan could not see

No `--telemetry`, no `--session-input`, no `audit` logs or AWS cost export.
The hosted public report’s `next_evidence` list is the honest remainder:
upload OTLP/GenAI traces if you want compositions (untrusted input,
privileged data, outbound send); upload sessions if you want agent-history
review.

Do not attach an unrelated incident fixture to someone else’s repo and talk
as if those traces came from that product. Public sample traces shipped with
this repository are for exercising `--telemetry`, labeled as samples.

## What changed when we added AWS evidence

Source-only Check on famous OSS is a cautious linter. The distinctive Check
report appears when you add the files the CLI already knows how to take, not
when you point it at Astro again.

The public CLI still does not call AWS. You export JSON yourself, then pass
the files. On 2026-08-24 we did that against a real sandbox account (IAM
credential CSVs plus Cost Explorer, Container Insights, CloudWatch
FilterLogEvents, and Bedrock model-invocation logs). Values, account ids, and
prompts stay out of this write-up.

| Surface | What Check did with it |
|---|---|
| IAM access-key CSV and console-password CSV | Source `scan` reported an AWS access-key pair and a literal password field. Those two files are the shapes the credential rules are written for. The collector still classifies generic `*.csv` as ordinary source, so they did not appear in the high-sensitivity path list. |
| CloudWatch FilterLogEvents (`audit --cloudwatch-log`) | Runtime error lines, AWS access-key ID shapes inside CloudTrail-formatted log events, and an AWS destination class. Pagination tokens on some groups kept log coverage incomplete. |
| Cost Explorer + Container Insights (`audit --aws-input`) | 1197 Task samples, CPU p95 about 0.1%, memory p95 about 5.6%. Finalized July dollars were ~$0, so there was no spend-to-review finding. A mixed window that included the still-open August month used to suppress all dollar findings; Check now scores finalized months and keeps Estimated periods as a coverage gap. |
| Bedrock model-invocation logs (`--telemetry --telemetry-format bedrock`) | 77 `InvokeModel` records (Claude Haiku) in a native FilterLogEvents export. The engine now unwraps the CloudWatch `message` field, so you do not have to pre-map the AWS CLI JSON into a bare array. |

```sh
aws ce get-cost-and-usage \
  --time-period Start=2026-07-01,End=2026-08-01 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  > cost-explorer.json

aws logs filter-log-events \
  --log-group-name /aws/ecs/containerinsights/your-cluster/performance \
  --start-time "$START_MS" \
  > container-insights.json

aws logs filter-log-events \
  --log-group-name /aws/bedrock/modelinvocations/your-app \
  --start-time "$START_MS" \
  > bedrock-invocations.json

npx @provenex/check audit . \
  --aws-input ./cost-explorer.json \
  --aws-input ./container-insights.json \
  --cloudwatch-log ./app-logs.json \
  --telemetry ./bedrock-invocations.json \
  --telemetry-format bedrock \
  --dry-run
```

`--dry-run` prints the upload preflight. A hosted run still needs
`PROVENEX_API_KEY` and `--yes`. Do not put live keys in the repo you scan
unless you intend the credential findings.

## Suggested quote for a CLI write-up

> We ran Provenex Check on public HEAD of Astro, Dub, Trigger.dev, and the
> official MCP servers. From source alone it flagged `pull_request_target`
> workflows (including ones the maintainers already annotated as
> no-checkout), git-tracked `.env` paths (Astro test fixtures; Trigger.dev
> symlinks to a local untracked file), local-dev password fields, and a few
> webhook-named files that still need a human to distinguish UI from inbound
> intake. It did not claim those products were exploited. It also did not
> score runtime agent behavior, because we did not upload traces. That gap is
> the next command: `provenex-check scan . --telemetry ./traces.otlp.json`,
> or `audit` with Cost Explorer, CloudWatch, and `--telemetry-format bedrock`
> for a Bedrock model-invocation export.
