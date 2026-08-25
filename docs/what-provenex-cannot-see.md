# Public coverage semantics

Provenex Check evaluates only the evidence included in the approved CLI
request. The hosted engine can connect supported observations across source,
session, telemetry, dependency, runtime, and cost inputs, but it cannot recover
events or context that were never supplied.

## Source-only runs

A source scan can evaluate selected files, configuration, manifests, lockfiles,
CI workflows, and explicitly supplied dependency-audit output. It does not by
itself establish:

- which code was deployed;
- which path executed at runtime;
- what an AI agent read or changed;
- effective cloud or SaaS permissions;
- customer-data access;
- production log outcomes; or
- provider spend.

The report labels this mode as source-bounded and asks for additional evidence
when another input could establish a stronger result.

## Session evidence

Supported AI-session inputs can show recorded tool activity, retries, failures,
credential-shaped access, and available token counters. They cannot establish
activity missing from the export, deleted provider state, browser history,
cookie state, or server-side account history.

Project attribution depends on the supported record carrying the required
working-directory metadata. Web conversation exports do not provide reliable
project attribution and are reported accordingly.

## Telemetry evidence

Telemetry coverage depends on what the emitter and export preserve:

- Missing trace or span identity can make a record unusable.
- Missing or broken parentage can prevent steps from being connected.
- Sampling can omit a source, action, or destination.
- Sparse audit events may show actions without their causal inputs.
- Unrecognized formats remain unevaluated rather than being interpreted as a
  supported shape.
- A completed trace supports retrospective analysis; it does not prove that an
  action was intercepted.

The supported public file formats are listed in the
[telemetry checklist](telemetry-checklist.md). File support does not include
vendor OAuth, pagination, backfill, or continuous monitoring.

## Runtime and cost exports

Fly and CloudWatch inputs are explicit local exports. An omitted page,
non-converged pagination token, sampling flag, truncation, or unsupported shape
keeps coverage incomplete.

AWS cost and utilization inputs are observations from the supplied export. They
do not prove future spend, guaranteed savings, application ownership, or the
business effect of changing a resource. Estimated billing periods remain
identified as estimated.

## Identity and authorization

An email, user ID, session ID, or workload name is useful only to the extent
that the source system assigns it consistently. A shared or caller-controlled
identifier can connect unrelated activity or fail to connect activity that
belongs together.

Evidence that an action occurred is not evidence that a person authorized it.
Provenex reports observed authorization and approval facts when supplied; it
does not infer intent from the action alone.

## Enforcement

A retrospective Red result is not a block receipt. A claim that an action was
held, denied, or completed requires evidence from the component that controlled
the action and an outcome bound to the same request.

No public Edge installation is currently available. Edge distribution remains
private and blocked under the [installation boundary](install.md).

## Reading report states

- **Observed** means the supplied evidence directly supports the statement.
- **Inferred** means the report applied a disclosed inference to supported
  evidence.
- **Not established** names a claim the supplied evidence cannot support.
- **Incomplete** means a requested or material input was missing, malformed,
  truncated, unsupported, or otherwise not fully evaluated.

A zero-finding result means no public finding was produced from the evidence
that was evaluated. It does not extend to omitted sources or incomplete
coverage.
