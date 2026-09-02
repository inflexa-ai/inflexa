## Context

The Docker gate at `src/sandbox/docker-client.ts:360-370` reads the lock
of the resolved farm. On an error it warns, sets `libsMounted` false, and
makes the container. The K8s gate at `src/sandbox/k8s-client.ts:623-635`
does the same, and it runs only when `libStorePvcRoot` is set. Under a
`fixed` farm source no resolver exists, thus that root carries the only
gate the shape has. A resolver refusal is different: `resolveFarmSource`
(`src/sandbox/farm.ts:129-144`) returns `farm_unavailable`, and no
container is made.

The client seam `createSandboxClient` (`src/sandbox/create-sandbox.ts`)
converts each `ResultAsync` of the backend ops with `unwrapOrThrow` at
lines 262, 282, 304, 322, 324, and 325. `unwrapOrThrow` wraps a
non-`Error` value in `ResultError`, whose message is the `message` field
of the value or, without one, the bare `type` (`src/lib/result.ts:53-67`).
No `SandboxError` variant carries `message`. `describeSandboxError`
(`src/sandbox/sandbox-error.ts:130`) has no runtime consumer.

The two surfaces that show a create failure: the profile ledger takes the
first line of the message, capped at 200 characters
(`src/tasks/data-profile.ts:1044-1049`). The run path records the message
on the step row and as the run failure reason
(`src/workflows/execute-analysis.ts:1265`, `:1285`, `:1290`), because the
create step sits before the `failStep` try (`src/workflows/sandbox-step.ts:456`
against `:649`). DBOS retries are opt-in, and the create step passes only
a name (`sandbox-step.ts:472`), thus a refusal fails the step one time.

## Goals / Non-Goals

**Goals:**

- An embedder can declare that its deployment cannot run without the
  store, and the gate then refuses in place of the degrade.
- A refusal, and each other sandbox failure, reaches the operator surfaces
  with its description and the reason of its cause.
- An unsatisfiable declaration fails at composition, not at the first
  sandbox.

**Non-Goals:**

- No change to the degrade, which stays the default and the CLI behavior.
- No change to the farm resolver contract or to `farm_unavailable`.
- No change to `submitExec`, which throws on its own step.
- No new export at the barrel.

## Decisions

**1. The fact is `packageStore: "required"`, and absent means degrade.**
The field names the deployment fact, not the remediation, the same rule as
`engineBindOwnership: "host-preserved"`: how the harness answers the fact
can change without a change to the embedder surface. A single-valued union
extends without a break. The factory threads it to `DockerClientConfig`
and `K8sClientConfig`.

**2. The variant is `farm_unusable`.** The gate proves the lock at the
resolved farm path, and `farm_unavailable` is its sibling: unavailable is
no farm from the resolver, unusable is a farm with no valid lock. The
variant carries `op`, `analysisId`, `farmPath`, `lockPath`, `lockError`
(the `FarmLockError` type), and `cause`. On Docker `farmPath` is the host
path and `lockPath` is the lock under it. On K8s `farmPath` is PVC-relative
and `lockPath` is the joined path under `libStorePvcRoot`. The name
`store_unusable` was rejected, because the gate tests the farm, and the
description can still say "package store" for the operator.

**3. The gate refuses in silence under the fact.** The value carries the
reason, and the consumer logs the throw. A warning at the gate would log
the same fault two times. The degrade path keeps its warning.

**4. The composition guard.** `createSandboxClient` throws when the fact is
set and no gate can run: Docker without `libStorePath`, K8s without
`libStorePvc`, or K8s with a `fixed` farm source and no `libStorePvcRoot`.
K8s with a `per-analysis` source and no root is not a contradiction: the
resolver owes the proof, and its refusal already stops the create. The
precedent is the tail-beside-readOnly throw in `src/sandbox/mount-plan.ts`.
The throw is at composition, because the embedder decides the fact there,
and a contradiction found at the first sandbox costs a run.

**5. The seam throws a `SandboxFailure`.** A class in `sandbox-error.ts`,
`SandboxFailure extends Error`, with `readonly error: SandboxError`. Its
message is `describeSandboxError(error)`, and `cause` is the variant, thus
a cause-chain reader keeps working and a consumer can match the class.
The seam keeps the sanctioned bridge: each site becomes
`unwrapOrThrow(result.mapErr((e) => new SandboxFailure(e)))`.
`toThrowable` passes an `Error` through untouched (`result.ts:80-81`),
thus no new bridge exists and the `must-use-result` patch stays as it is.
The two DB unwraps of the seam, the registry write and the registry clear,
stay on plain `unwrapOrThrow`, because they carry a `DbError`.

The alternative, a `message` field on the new variant only, was rejected:
it leaves each other variant as one word on the ledger, and it puts a
rendering concern into the data.

**6. Each description carries the bounded first line of its cause.** Where
a variant carries a `cause`, `describeSandboxError` appends the first line
of the cause message, bounded to 200 characters, the same bound as the
profile ledger. The engine or the API then names its reason on the run
row and on the ledger. The bound keeps a stack or a response body out of
the row. A cause without a message adds nothing. `farm_unavailable` takes no
cause line, because its head already carries the reason of the resolver,
and a second dash on one row would repeat it.

A `ZodError` is the cause of `lock_invalid`, and its message is multi-line
JSON whose first line is `[`. Thus a zod cause renders as its first issue,
the path and the message, and not as its first line. Any other cause
renders its first message line.

**7. What `farm_unusable` reads as.** `farm unusable (<op>: <analysisId>) —
no usable inflexa.lock at <lockPath> (<lockError>)`, then the cause line.
Thus the operator reads the path and the parse reason, and the pairing
with the store state is one look.

## Risks / Trade-offs

- [A consumer matched the bare `type` in a message] → No consumer in
  `harness/src` or `cli/src` does. The class carries the variant for one
  that wants it.
- [An engine message carries a path or a secret into the run row] → The
  line is bounded, and the description names the op. The run row carried
  the bare type before, and the log carried the whole cause then as now.
- [The guard refuses a boot that ran before] → Only under the fact, which
  no embedder sets today. An embedder that sets it without a store gets
  the contradiction at boot, which is the point.
- [A CLI store mid-download] → The CLI does not set the fact, thus its
  degrade stays.

## Migration Plan

No data changes. An embedder that wants the refusal sets one field. An
embedder that sets nothing sees the fuller messages and no other change.

## Open Questions

_None._
