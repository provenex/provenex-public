# Provenex Check for coding agents

This repository is the public Provenex Check CLI. Scoring stays on the hosted
service. No engine is bundled.

Copy [`cli/provenex-check/skills/provenex-check/SKILL.md`](cli/provenex-check/skills/provenex-check/SKILL.md)
into the project you are scanning:

- Cursor: `.cursor/skills/provenex-check/SKILL.md`
- Claude Code: `.claude/skills/provenex-check/SKILL.md`

Then, from that project root, with no API key:

```sh
npx @provenex/check demo
npx @provenex/check plan .
npx @provenex/check scan . --dry-run --no-prompt
```

Stop after the dry-run unless the user asked to upload and reviewed the
preflight. `--yes` is upload approval, not consent to collect AI history.
Never put API keys on the command line. Never call a missing finding fixed.
Matching session tool paths can join to submitted files; unmatched stay
unjoined. Do not treat a join as proof the agent wrote the current bytes.

`brief`, `coverage`, and `@provenex/check/checkpoint` talk to a tenant App
gateway, not the hosted Check API.
