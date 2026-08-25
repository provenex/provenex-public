# Public credentials and verification

This document defines the credential and signature behavior visible through the
public Provenex Check CLI. It does not describe private Engine hosts or Edge
deployment internals.

## API credentials

A hosted run requires a Provenex API key. Production credentials are accepted
only from:

- `PROVENEX_API_KEY`; or
- `~/.config/provenex/check.json`, when the file is regular, owner-controlled,
  and mode `0600`.

The CLI does not accept a production API key as a command-line value. It pins
production requests to `https://api.provenex.ai`; an option or environment
variable cannot redirect that credential and approved evidence to another
remote host.

Loopback development uses the separate `PROVENEX_CHECK_DEV_API_KEY`. A loopback
run never falls back to the production environment variable or configuration
file.

`--dry-run` does not read a production key. After approval and key loading, the
CLI rejects selected evidence that contains the exact active bearer or its
JSON-escaped representation before making a request.

## Response signature

Each successful response carries the canonical public report, a signature, and
an ephemeral public key for that run. The CLI validates the canonical bytes and
signature before rendering terminal, JSON, or HTML output.

Because the verification key arrives in the same response, this check proves
only envelope self-consistency. It does not establish a durable Provenex issuer
identity or replace HTTPS server authentication and API authorization.

The response does not provide an Engine source commit, private signing
material, private rule identifiers, or internal analysis structures.

## Local report files

JSON and HTML reports are optional local copies. The CLI creates them
owner-only, outside the scanned project, and does not replace an existing file
unless `--force` is explicit. Symlink outputs are rejected.

These files are outside the hosted application's ephemeral data policy. Store
or delete them under your own retention policy.

## Re-run binding

`--verify-against` accepts an owner-only prior JSON report from the same local
project and compares the new validated result locally. The hosted request does
not receive the prior report or its path.

The report carries an opaque client-derived project scope so unrelated local
projects are not compared as one. Moving the project or rotating its API key
changes that scope. Comparison results remain limited to `still-present` and
`not-verifiable`; a missing finding is not automatically treated as fixed.

## Public/private boundary

The public CLI contains no Engine private key or scoring engine. Provenex Edge
is not publicly distributable under the current [installation boundary](install.md).

Report credential exposure or signature-validation failures to
[security@provenex.ai](mailto:security@provenex.ai) according to
[`SECURITY.md`](../SECURITY.md).
