# Tasks — add-poll-liveness-escalation

## 1. Shared liveness module

- [x] 1.1 Create `src/sandbox/liveness.ts`: the three-valued `ProbeVerdict`
      (`dead` w/ `oomKilled` | `alive` | `inconclusive`), a never-throwing
      probe runner wrapping an injected `isAlive`, the consecutive-unavailable
      escalation policy (unavailable increments, ok resets, threshold arms and
      resets), and `syntheticFailureResult(execId, liveness)` hoisted from
      `watchdog.ts`'s inline construction (reasons `sandbox-oom-killed` /
      `sandbox-dead`).
- [x] 1.2 Unit tests `src/sandbox/liveness.test.ts`: policy count/reset/arm
      transitions, probe wrapper mapping (dead/alive/throw→inconclusive),
      constructor reason selection and `ExecResult` shape.
- [x] 1.3 Refactor `src/sandbox/watchdog.ts` to consume
      `syntheticFailureResult`; `watchdog.test.ts` stays green unchanged (or
      with mechanical import updates only).

## 2. Poll-loop escalation

- [x] 2.1 Add the `isAlive?: (ref: SandboxRef) => Promise<SandboxLiveness>`
      seam to `AwaitExecOptions` in `src/sandbox/await-exec.ts`, documented as
      client-wired with escalation skipped when absent.
- [x] 2.2 Wire the escalation into `awaitExecPoll`: track consecutive
      `unavailable` outcomes via the policy; on arm, run the probe as a durable
      step `sandbox.probe-liveness.${execId}.${k}` immediately after the
      threshold-crossing poll (before the deadline gate and sleep); `dead` →
      return the synthetic-failure result; `alive`/`inconclusive` → reset and
      resume. Update the module header comment's liveness story.
- [x] 2.3 Tests in `src/sandbox/await-exec.test.ts` covering the spec
      scenarios: dead machine fast-fails with `sandbox-dead`; OOM reason
      surfaces; alive probe resumes polling (deadline still bounds); ok poll
      resets the streak (no probe); probe throw → inconclusive, no workflow
      error; probe steps replay with stable names/positions given the same
      poll outcomes; no seam → no escalation.

## 3. Client wiring

- [x] 3.1 In `src/sandbox/create-sandbox.ts`, pass the backend ops' `isAlive`
      into the `awaitExec` options so the client-composed loop always
      escalates.
- [x] 3.2 Cover the wiring: a client-composed `awaitExec` against a dead-machine
      fake escalates and returns the synthetic failure (extend the existing
      await-exec or client-level tests, whichever fixture fits).

## 4. Verification & docs

- [x] 4.1 `tsc -p tsconfig.json` clean; `bun test` green; `bun run format:file`
      on every touched `src/` file.
- [x] 4.2 Update `harness/CLAUDE.md` and `CONTEXT.md` sandbox-exec liveness
      wording: poll mode fast-fails a dead machine via in-loop escalation (the
      "bound by step.timeout" caveat is gone); callback mode unchanged.
- [x] 4.3 `openspec status --change add-poll-liveness-escalation` shows all
      artifacts done; change ready for apply/archive flow.
