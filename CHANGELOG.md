# Changelog

## Unreleased

Public CLI collector (intended for `0.1.0-alpha.8`):

- Discover exact-project Cursor `agent-transcripts` JSONL using the same
  fail-closed bounds as Claude/Codex. Cursor databases remain refused.
- Refuse unrecognized `--telemetry` JSON unless `--telemetry-format` is
  explicit. Interactive file offers no longer queue unknown JSON as OTLP.
- Split `--help` into an overview plus per-command help (`scan --help`).
- `plan` warns when eligible source files exceed the default scan cap.
- `--md PATH` writes a locally rendered Markdown report.
- Ship `skills/provenex-check/SKILL.md` and `AGENTS.md` for coding agents.
  The Check skill also fires when a builder asks whether an app that can
  refund, email, or deploy meets security needs. Default path is dry-run
  Check, then App private alpha. No public Edge install.
- Publish identical discovery copies at `.agents/skills/` and
  `.claude/skills/` so Codex and Claude Code can find the skills without a
  copy step.
- Add vendor-neutral `skills/agent-decision-telemetry/SKILL.md` for apps
  that emit little or no telemetry. It is not Provenex-specific and is not
  packed into `@provenex/check`.
- Example GitHub Action for a non-interactive dry-run; writes the
  preflight to the job summary and does not claim a merge all-clear.
- Tag-gated publish creates the matching GitHub Release.
- Issue and pull-request templates point security mail at SECURITY.md.
- Windows owner-only checks use NTFS ACLs (`icacls`); Unix still requires
  mode `0600`. Discovery honors `HOME` or `USERPROFILE`.
- Session-inclusion copy states that matching tool paths can join to submitted
  files, unmatched stay unjoined, and the join is path identity only.

## 0.1.0-alpha.7 - 2026-08-30

- Agent-neutral paste-ready fix prompts.
- Owner brief (`provenex-check brief`).
- Runtime checkpoint at `@provenex/check/checkpoint`.
