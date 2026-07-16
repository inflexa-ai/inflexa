## 1. The seam

- [x] 1.1 Add `src/lib/logger.ts` defining `LogLevel`, `LogFields`, and the message-first `Logger` interface (`debug`/`info`/`warn`/`error` + `with`). Document why it is message-first and not pino-shaped.
- [x] 1.2 Add `src/lib/console-logger.ts` exporting `createConsoleLogger()`, accumulating `with()` bindings and merging them into each record. This is the one sanctioned `console` site — justify it in a comment.
- [x] 1.3 Export `Logger`, `LogLevel`, `LogFields`, and `createConsoleLogger` from `src/index.ts`.
- [x] 1.4 Add a unit test asserting `with()` merges bindings into emitted records and that later `with()` calls compose onto earlier ones.

## 2. Cut the pino type dependency

- [x] 2.1 Replace `import type pino from "pino"` with the `Logger` type in `runtime/boot.ts`, `runtime/dbos.ts`, `runtime/shutdown.ts`, `runtime/connection-budget.ts`.
- [x] 2.2 Replace it in `sandbox/create-sandbox.ts`, `sandbox/reaper.ts`, `sandbox/notification-sweep.ts`, `sandbox/docker-client.ts`, `sandbox/watchdog.ts`. The narrowed `Pick<pino.Logger, ...>` uses widen to `Logger` and resolve `?? createNoopLogger()` once per entry point, dropping the `deps.logger?.` chaining.
- [x] 2.3 Flip every migrated call from pino's object-first `logger.info(fields, msg)` to `logger.info(msg, fields)`, and replace hand-typed `[module]` message tags with `named(...)`.
- [x] 2.4 Remove `pino` from `harness/package.json` `dependencies`; confirm no `harness/src` file references it (`grep -rn "pino" src/`). Runtime tests now use the shared `silentLogger` (`__tests__/setup/logger.ts`) instead of a silent pino.
- [x] 2.5 Run `tsc -p tsconfig.json` — it must be clean before threading begins.

## 3. The lineage_attestation path (the point of the change)

- [x] 3.1 Add `logger?: Logger` to `SandboxStepDeps` (`workflows/sandbox-step.ts`), no-op when omitted.
- [x] 3.2 Convert `sandbox-step.ts`'s 7 `console.*` sites. `failStep` becomes `logger.error("step failure", { errorClass, ...logger.errorFields(err) })` — the scrubbed `throw new Error(safe)` and the scrubbed DB/emit surfaces are untouched; only the operator-side record changes.
- [x] 3.3 Bind step context once via `.named("sandbox-step").with({ runId, stepId, agentId })` in the workflow body rather than repeating identifiers per call. The module-scoped `safeRun`/`safeRunValue`/`tryTeardown` helpers take the bound logger as a parameter.
- [x] 3.4 Add `logger?: Logger` to `PostStepPipelineDeps` and convert the 3 `console.*` sites in `execution/post-step-pipeline.ts`.
- [x] 3.5 Add `logger?: Logger` to `ReconcileManifestInput` and convert the 3 `console.*` sites in `execution/reconcile-manifest.ts` — the phantom-drop and non-file-drop lines, which identify what failed attestation.
- [x] 3.6 Ensure the two `prov_bridge` failure paths and the `fillInputHashesFromDisk` throws are distinguishable: each attestation throw logs a `throwSite` discriminator (`container-prefix-bound` / `workspace-root-bound` / `input-enoent` / `input-stat`) plus the ref's `path` and `source`; the registry rejection logs `externalFailed`/`failures` under `[post-step.reconcile]`.
- [x] 3.7 Test that a failed attestation names the input, its `source`, and the throw site through a capturing `Logger` (`reconcile-manifest.test.ts`), plus that an unwired logger degrades to silence without failing the reconcile.

## 4. CLI embedder

- [x] 4.1 Add a pino → `Logger` adapter at the CLI composition root (`runtime.ts`'s `pinoAsHarnessLogger`, kept beside its single caller): flip argument order, map `with(fields)` → `child(bindings)`, render `named()` as the message prefix (NOT a `module` binding — `getLogger("harness")` already owns that field and the existing lines read `[dbos] launched`). `errorFields` hands the raw value to pino's own `err` serializer, which is richer than the shipped string mapping.
- [x] 4.2 Pass the adapter to `bootHarness` in `cli/src/modules/harness/runtime.ts`, replacing the raw pino logger.
- [x] 4.3 Carry it on `RunEngineComposition` (REQUIRED there, though the harness deps take it optionally — a bundle assembled without it type-checks and silently discards every diagnostic) and pass it from `buildSandboxStepDeps`.
- [x] 4.4 `bun run typecheck` + `bun test` green in `cli/`; verified end-to-end that a reconcile attestation failure lands in a real pino file destination carrying `module: "harness"`, the `[reconcile-manifest]` prefix, `runId`/`stepId`/`agentId`, and `path`/`source`/`throwSite`.

## 5. Sweep the remaining console sites

- [x] 5.1 `tasks/data-profile.ts` (12) via `DataProfileDeps` + `DataProfileTriggerDeps`; module-scoped `logTerminalNoop` takes the bound logger.
- [x] 5.2 `workflows/execute-analysis.ts` (7) via `ExecuteAnalysisDeps`.
- [x] 5.3 `workflows/execute-target-assessment.ts` (3), `target-assessment/progress.ts` (2), `phase5-persist.ts` (1), `lib/llm-step.ts` (1). `emitProgress`/`stampSynthesis` take the logger as a parameter (they hold no deps bag); `structured-llm` forwards it to `runLlmStep`.
- [x] 5.4 `execution/ephemeral-runner.ts` (4), `step-summary.ts` (2), `report-runner.ts` (2), `artifact-metadata.ts` (2), plus `artifact-registration.ts` (1) — the latter takes the logger as a PARAMETER, not a field on `ArtifactRegistrationInput`, since that type is the seam payload handed verbatim to an embedder's `registry.register`.
- [x] 5.5 `lib/chrome.ts` (5) via `ChromeConfig`, `state/init.ts` (1), `sandbox/k8s-client.ts` (1) via `K8sClientConfig`.
- [x] 5.6 `tools/workspace/execute-command.ts` (1), `tools/iterate-report.ts` (1) — both already factory closures. `tools/bio/search-dgidb.ts` (1) was a bare `defineTool` const: converted to `createSearchDgidbTool(deps)` and rewired at its 3 call sites (conversation-agent, sandbox/shared, literature-reviewer). `ToolContext` stays `{session, signal, emit, runStep}` — a tool that logs is dep-bearing, which is the existing rule (cf. `createSearchClinvarTool`).
- [x] 5.7 `lib/otel.ts` — the TracerProvider `console.log` banner is now `logger.debug`, removing the stated blocker behind the CLI's `initTelemetry: () => {}`.
- [x] 5.8 Zero remaining: `grep -rn "console\.\(log\|warn\|error\|info\|debug\)(" src/ --include="*.ts" | grep -v console-logger` returns nothing. Full suite 1026 pass (up from a 1011 pre-change baseline); the 111 failures are all the Postgres testcontainer with Docker down, unchanged in kind.

## 6. Lock it in

- [x] 6.1 `no-console: "error"` on `src/**/*.ts` in `harness/eslint.config.js`, exempting `src/lib/console-logger.ts` + its test BY PATH in the config — no inline `eslint-disable` anywhere. Verified both directions: a planted `console.warn` in a normal src file errors (`Unexpected console statement`), and the exempt realization passes.
- [x] 6.2 **Fully green against real infrastructure**: `TESTCONTAINERS_RYUK_DISABLED=true bun test` → harness **1233 pass / 0 fail**, cli **1147 pass / 0 fail** — including the DBOS workflow-replay and sandbox-step suites that exercise the changed bodies against a real Postgres + DBOS engine. (The ~111 failures seen earlier were never regressions: `/.*Started.*/` is Ryuk's wait, not Postgres's — testcontainers' reaper sidecar fails to start on this machine. Docker being down produces the identical message, which is what masked it.) Tests use the shared `silentLogger` / `createCapturingLogger` (`__tests__/setup/logger.ts`) instead of a silent pino. NOTE: `bun run lint` (`eslint .`) fails on `scripts/smoke.mjs` — a `.mjs` outside the type-aware program. Verified pre-existing by running HEAD's own config: identical failure. `npx eslint src/` is clean apart from a pre-existing `neverthrow/must-use-result` finding in `providers/ai-sdk.test.ts:346`. Both are out of scope here; see 7.3.
- [x] 6.3 `tsc -p tsconfig.json` clean; `bun run format` applied. (It reformats ALL of `src/`, so it also touched two files unrelated to this change — `reference-data/catalog.test.ts`, `tools/sandbox/list-available-refs.ts` — which were reverted rather than committed as drift.)
- [x] 6.4 `harness/CLAUDE.md`: the DI principle claimed `Logger` was already an injected construction dep — now true. Added design principle 7 (diagnostics through the seam, never console; renumbered the rest), listed the seam in the public-surface paragraph, and rewrote the Debugging section — `LOG_LEVEL` is the embedder's knob now, and a step failure's cause exists ONLY in the log line since `failStep` scrubs everything downstream.
- [x] 6.5 Replaced the `structured-logging` Purpose prose at archive time. `openspec archive` applies requirement operations only, so the paragraph opening "The harness logs operationally through **pino**" survived the archive and contradicted the requirements directly below it — rewritten by hand in `openspec/specs/structured-logging/spec.md` as part of the same archive step.


## 7. Follow-ups (not this change)

- [ ] 7.1 Re-enable harness telemetry at the CLI (`initTelemetry: initOtel`) now that the `lib/otel.ts` banner is gone, and confirm `cortex.artifact.reconcile.dropped` reports. The two OTel setups are complementary, not duplicative — the harness does traces + metrics, the cli does logs — so this should be additive, but it is a behaviour change that deserves its own verification.
- [ ] 7.2 With diagnostics landing, capture a real `lineage_attestation` failure and read its `throwSite` + the ref's `source` — then open the change fixing the inotify `IN_OPEN`-as-read misclassification (`provenance_inotify_linux.go`'s `classifyInotifyMask` buckets every non-CREATE/DELETE event as a read, so write-opens and third-party opens become phantom "inputs" that fail-fast attestation).
- [ ] 7.3 Pre-existing lint debt this change surfaced but did not touch: `bun run lint` (`eslint .`) dies on `scripts/smoke.mjs` — a `.mjs` outside `tsconfig.eslint.json`'s program, so type-aware rules cannot load — and `providers/ai-sdk.test.ts:346` has an unhandled `Result`. Both fail identically on HEAD's config.
