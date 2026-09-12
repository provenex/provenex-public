# Contributing to provenex-public

This repository is the public Provenex Check CLI, its schemas, and synthetic
evaluation material. The analysis engine is not in this tree.

Security reports go to [security@provenex.ai](mailto:security@provenex.ai).
See [SECURITY.md](SECURITY.md). Do not open a public issue with customer
telemetry, credentials, or private reports.

## CLI changes

Work in `cli/provenex-check`.

```sh
cd cli/provenex-check
npm test
npm run check:pack
```

`check:pack` pins the published file list. Adding a shipped file is an
intentional boundary change: update `scripts/assert-pack-manifest.mjs` in the
same commit.

## What not to send

- Do not add the private engine, scoring rules, or internal classifier names.
- Do not treat `--yes` as consent to collect AI history.

## Release

Publish `@provenex/check` only from a `provenex-check-v*` tag through the
tag-gated workflow in the public repository. Match `package.json` version.
Write the CHANGELOG entry before the tag. The workflow publishes to npm and
creates the matching GitHub Release.

Do not publish a `*-private-v*` overlay coordinate. Node 22 remains the
minimum; CI also runs Node 24.
