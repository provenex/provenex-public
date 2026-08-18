# Provenex Check ephemeral data policy

Policy identifier: `provenex-check-ephemeral-v1`

This versioned policy applies to evidence explicitly approved for a single
public Provenex Check request processed by the shared multi-tenant application.
The CLI displays this policy before consent and includes its identifier in the
request. A response is rejected unless it declares this exact policy.

## Application retention and workspace lifecycle

For this policy version:

- raw uploaded evidence has zero seconds of application-scope retention;
- derived report results have zero seconds of application-scope retention;
- processing uses a request-only server workspace; and
- that workspace must be deleted before the response is returned.

“Application-scope” describes the Provenex Check application’s persistence
behavior. It does not claim that the CLI can independently observe or prove
server deletion. It also does not govern copies the user writes locally,
ordinary account/authentication/billing records that contain no uploaded
evidence, or infrastructure metadata governed by separate published terms.
Request bodies and raw evidence must not be written to application logs.

## Returned data

The response contains only the strict public report DTO, an ephemeral per-run
signature envelope, the applied policy declaration, and bounded run metadata.
It must not contain raw source, raw telemetry, private rule identifiers,
private engine reports, server-rendered terminal text or HTML, source commits,
model prompts, or internal scoring machinery.

The CLI verifies that the canonical public report bytes are self-consistent
and that their Ed25519 signature matches the included ephemeral `run-*` public
key. Because the verification key arrives in the same response, this detects
accidental corruption and envelope inconsistency only. It does **not** prove
Provenex issuer identity, server authenticity, or durable attestation. HTTPS
and API authentication remain required for transport and account access.

## Local outputs

The CLI renders terminal and HTML views locally from the validated public DTO.
If the user requests JSON or HTML output, those files are local user-controlled
copies and are outside the zero-retention application policy. Report outputs
are owner-only files, must be outside the scanned tree, and are not overwritten
without an explicit safe `--force` request.

Policy changes that alter retention, scope, or workspace lifecycle require a
new policy identifier and matching CLI consent. Security concerns should be
reported according to [`SECURITY.md`](../SECURITY.md).
