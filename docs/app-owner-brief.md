# Provenex App owner brief

The owner brief is the read-only, agent-friendly way to ask a provisioned
Provenex App workspace what needs attention now. It is part of the private
design-partner alpha; running the command does not create an App account,
workspace, connection, or credential.

The App gateway creates the priorities from workspace-scoped coverage,
connector health, and durable action custody. The public CLI authenticates,
validates, and renders that server-authored result. It does not contain a
detector, scoring rule, policy engine, or local copy of the Provenex engine.

## One-time setup

Accepted design partners receive a separate tenant-scoped `brief:read`
workload key and their App gateway origin during manual onboarding. Add
`coverage:read` only when the same process also needs the coverage command.
Store both outside command history:

```sh
export PROVENEX_APP_GATEWAY_URL='https://your-app-gateway.example'
export PROVENEX_SDK_KEY='pvx_sdk_...'
```

The URL is not a credential. The key is. Keep it in the environment or a
secret broker used by the agent process; never put it in a command argument,
prompt, repository, issue, or report.

Do not reuse a `decide` or `receipt:write` key for a morning-brief agent. Those
scopes can authorize materially different operations even though the brief
itself is read only.

## Read the brief

For a person:

```sh
npx @provenex/check brief
```

For an agent or morning-brief automation:

```sh
npx @provenex/check brief --format json
```

JSON is written to standard output with no interactive prompt or ANSI control
sequence. Operational failures go to standard error. A successful request
returns exit code zero even when an owner action exists; the versioned DTO's
`status` and `actions[].priority` carry that state.

Each action contains only:

- stable action id;
- `now` or `next` priority;
- bounded category;
- plain-language title and reason;
- one next step; and
- one fixed path inside Provenex App.

The response also contains bounded health areas and the coverage note. Unknown
server fields, including any private analysis structure, are discarded before
JSON or terminal output.

## Suggested agent instruction

> Check Provenex. Tell me only what needs my attention now, why, what I should
> do next, and what was not checked. Do not approve, retry, release, or execute
> an action.

The current brief is read only. It cannot approve a held action, call a
provider, mutate a connection, or release custody. Those operations require a
separate, exact-action authorization boundary rather than an instruction in a
prompt.

## Coverage boundary

An empty action list means only that the areas evaluated by this brief
produced no owner action. It is not an all-clear for an application, agent,
store, or provider. Connected credentials are not proof of coverage, and an
absent area remains not evaluated, never safe.

The gateway applies a bounded read to durable custody. If that read is
truncated, counts are floors, coverage is partial, and a sampled enqueue time
is not labelled as the workspace's absolute oldest action.
