# Public installation boundary

The supported public installation is the Provenex Check CLI:

```sh
npm install -g @provenex/check
provenex-check --version
```

You can also run it without a global install:

```sh
npx @provenex/check scan /path/to/project --dry-run
```

Follow [Provenex Check onboarding](onboarding.md) before approving a hosted
analysis request.

## Provenex Edge is not publicly available

There is no supported public Edge image, Compose kit, registry login, download
URL, bootstrap command, or customer installation procedure.

Edge distribution is private and blocked until both release conditions are
complete:

1. the customer artifact no longer links the compiled private engine; and
2. every previously published source-leaking or engine-bearing image and kit
   has been retired.

Do not use an archived Edge command, image name, token endpoint, or bundle from
an earlier repository revision. Functional source or a locally runnable image
does not make that artifact approved for distribution.

## Architecture invariant

The proprietary engine remains server-side. A future customer component may
collect evidence, retain customer-controlled state, minimize a scoring request,
verify a signed decision, and apply that decision at an enforcement point. It
must not contain the private scoring engine or expose its implementation.

The public CLI follows a separate contract: it uploads only the bounded evidence
shown in its approved preflight for one hosted run. See the
[data policy](provenex-check-data-policy.md) and
[public product contract](provenex-check.md).
