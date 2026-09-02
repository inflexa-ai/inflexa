# Tasks — require-the-package-store

## 1. The fact and the variant

- [x] 1.1 Add `packageStore?: "required"` to `CreateSandboxClientConfig`,
  `DockerClientConfig`, and `K8sClientConfig`, with a doc that names the
  deployment fact and the degrade default (`src/sandbox/create-sandbox.ts`,
  `src/sandbox/docker-client.ts`, `src/sandbox/k8s-client.ts`).
- [x] 1.2 Thread the field from the factory to both backend ops.
- [x] 1.3 Add the `farm_unusable` variant to `SandboxError` with `op`,
  `analysisId`, `farmPath`, `lockPath`, `lockError`, and `cause`
  (`src/sandbox/sandbox-error.ts`).

## 2. The two gates

- [x] 2.1 Docker gate: under the fact, return `farm_unusable` before any
  container work, with no warning. Keep the degrade and its warning
  without the fact.
- [x] 2.2 K8s gate: the same, with `lockPath` as the joined path under
  `libStorePvcRoot`.

## 3. The composition guard

- [x] 3.1 In `createSandboxClient`, throw when the fact is set and no gate
  can run: Docker without `libStorePath`, K8s without `libStorePvc`, or
  K8s with a `fixed` farm source and no `libStorePvcRoot`. The message
  names the missing field.

## 4. The seam and the description

- [x] 4.1 Add `SandboxFailure extends Error` to `src/sandbox/sandbox-error.ts`:
  `readonly error: SandboxError`, the message from `describeSandboxError`,
  and `cause` set to the variant.
- [x] 4.2 At the six sandbox-op sites of `createSandboxClient`, bridge with
  `unwrapOrThrow(result.mapErr((e) => new SandboxFailure(e)))`. Leave the
  two registry unwraps as they are.
- [x] 4.3 Make `describeSandboxError` append the bounded first line of the
  cause message where a variant carries a cause with a message, with a
  named constant for the bound, and add the `farm_unusable` case. A zod
  cause renders as its first issue, the path and the message.

## 5. Tests

- [x] 5.1 `src/sandbox/docker-client.test.ts`: under the fact, an invalid
  lock refuses with `farm_unusable`, the error carries the lock path and
  `lock_invalid`, no container is created, and no warning is logged.
  Without the fact, the degrade tests stay green.
- [x] 5.2 `src/sandbox/k8s-client.test.ts`: the same under the host-side
  gate, with the joined lock path and no Job.
- [x] 5.3 `src/sandbox/create-sandbox.test.ts`: the fact reaches both
  backend ops, the three contradictions throw at composition with the
  field named, and a backend error surfaces as a `SandboxFailure` with the
  description as its message and the variant as its cause.
- [x] 5.4 `describeSandboxError` tests: the `farm_unusable` text, the
  appended cause line, the bound, a cause without a message, and a zod
  cause that renders as its first issue.

## 6. Verification

- [x] 6.1 Run `bun run format:file` on each changed file under `src/`.
- [x] 6.2 Run `tsc -p tsconfig.json`, `bunx eslint` on the changed files,
  and `bun test`.
