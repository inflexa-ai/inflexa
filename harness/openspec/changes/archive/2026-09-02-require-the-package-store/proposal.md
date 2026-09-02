# Require the package store

## Why

At each sandbox create the backend proves the `inflexa.lock` of the farm.
On a failure it degrades: the store mounts drop, a warning is logged, and
the container is still made. On the managed service that is a run that
spends tokens on steps that can import nothing, and the warning line is
the one signal. The embedder knows that its deployment cannot work without
the store, but it has no way to declare that fact. A refusal at create
already reaches the failure paths of an embedder, thus a declared fact that
turns the degrade into a refusal is the smallest change.

The refusal must also name its reason. Today the client seam throws a
`ResultError`, which renders a structured error by its bare `type`, and
`describeSandboxError` has no runtime consumer. Thus a create failure
reaches the profile ledger and the step row as one word.

## What Changes

- `CreateSandboxClientConfig` gains the fact `packageStore?: "required"`, a
  single-valued union, threaded to both backend configs. Absent keeps the
  degrade, thus the CLI changes nothing.
- `SandboxError` gains the variant `farm_unusable`: the resolved farm has
  no usable `inflexa.lock`. It carries the farm path, the lock path, the
  lock error type, and the cause.
- Under the fact, the lock gate of each backend refuses with
  `farm_unusable` before any container or Job exists. Without the fact,
  the gate degrades as today.
- `createSandboxClient` refuses at composition when the fact cannot be
  proved: no store configured, or a K8s `fixed` farm source without
  `libStorePvcRoot`.
- The client seam throws a `SandboxFailure` for each sandbox op: the
  message is `describeSandboxError`, and the variant rides as the cause.
  **BREAKING** for a consumer that matched the bare `type` in a message.
- `describeSandboxError` appends the bounded first line of the cause of
  each variant that carries one, thus the engine reason reaches the
  operator surfaces.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `package-store`: the lock-contract requirement gains the declared fact,
  the refusal under it, and the composition guard.
- `docker-sandbox-provider`: the farm-resolution requirement gains the
  refusal under the fact. A new requirement states what the client seam
  throws and what a description carries.

## Impact

- `src/sandbox/create-sandbox.ts` — the config field, the composition
  guard, the seam throw at the six sandbox-op sites.
- `src/sandbox/sandbox-error.ts` — the variant, the `SandboxFailure`
  class, the cause line in `describeSandboxError`.
- `src/sandbox/docker-client.ts` and `src/sandbox/k8s-client.ts` — the
  config field and the refusal branch of each gate.
- Tests beside each file, and `src/sandbox/create-sandbox.test.ts` for the
  forward, the guard, and the seam.
- Consumers see a fuller message: the profile ledger takes the first line
  of it, and the run path records it on the step row.
- Not affected: the farm resolver contract, `submitExec`, the mount plan,
  the CLI, and the two DB unwraps of the seam.
