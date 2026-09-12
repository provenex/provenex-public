---
name: provenex-check
description: >-
  Runs the public Provenex Check CLI as a consent-first collector. Use when the
  user asks to run provenex-check, @provenex/check, a Provenex scan, plan, or
  dry-run, or to inspect what a hosted Check would upload. Never uploads without
  an explicit --yes from the user, and never puts API keys on the command line.
---

# Provenex Check

The CLI is a collector. Scoring stays on the hosted service. No engine is
bundled.

Copy this file into the project you are scanning:

- Cursor: `.cursor/skills/provenex-check/SKILL.md`
- Claude Code: `.claude/skills/provenex-check/SKILL.md`

Codex and other agents can follow `AGENTS.md` at the provenex-public root.

## Default path

From the project root, in this order. None of these needs a key:

```sh
npx @provenex/check demo
npx @provenex/check plan .
npx @provenex/check scan . --dry-run --no-prompt
```

`plan` inventories evidence. `--dry-run` prints the exact upload preflight.
`--no-prompt` skips TTY discovery so the command is non-interactive.

Stop after the dry-run unless the user asked to upload. Show the preflight
and wait.

## Hosted scan

Only if the user asked to upload and reviewed the preflight:

- Read `PROVENEX_API_KEY` from the environment or `~/.config/provenex/check.json`.
  Never pass a key as an argument.
- Write reports outside the scan root, owner-only:

```sh
mkdir -m 700 "$HOME/provenex-reports"
npx @provenex/check scan . --yes --no-prompt \
  --json "$HOME/provenex-reports/check.json" \
  --md "$HOME/provenex-reports/check.md"
```

`--yes` approves the displayed upload only. It is not consent to collect AI
history. Add `--discover-ai-history` only when the user asked to include
exact-project Claude, Codex, or Cursor sessions. Matching tool paths can join
to submitted files. Unmatched stay unjoined. Do not treat a join as proof the
agent wrote the current bytes.

## Do not

- Upload without `--yes` after a reviewed preflight
- Put keys on argv (`--api-key`, `PROVENEX_API_KEY=... command`)
- Pass `--api-url` except for loopback development
- Include Cursor `state.vscdb`, browser profiles, or login stores
- Call a missing finding "fixed"
- Run `brief`, `coverage`, or import `@provenex/check/checkpoint` for a
  source scan; those talk to an App gateway, not the hosted Check API

## Help

```sh
npx @provenex/check --help
npx @provenex/check scan --help
```
