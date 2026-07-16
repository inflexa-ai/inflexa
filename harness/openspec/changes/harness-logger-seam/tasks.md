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

- [ ] 3.1 Add required `logger: Logger` to `SandboxStepDeps` (`workflows/sandbox-step.ts`).
- [ ] 3.2 Convert `sandbox-step.ts`'s 7 `console.*` sites. `failStep` becomes `logger.error("[sandbox-step] step failure", { runId, stepId, errorClass, err })` — keep the scrubbed `throw new Error(safe)` and the scrubbed DB/emit surfaces exactly as they are; only the operator-side record changes.
- [ ] 3.3 Bind step context once via `deps.logger.with({ runId: input.runId, stepId: input.stepId })` in the workflow body rather than repeating identifiers per call.
- [ ] 3.4 Add required `logger: Logger` to `PostStepPipelineDeps` and convert the 3 `console.*` sites in `execution/post-step-pipeline.ts`.
- [ ] 3.5 Add required `logger: Logger` to `ReconcileManifestInput` and convert the 3 `console.*` sites in `execution/reconcile-manifest.ts` — the phantom-drop and non-file-drop debug lines, which are the ones that identify what failed attestation.
- [ ] 3.6 Ensure the two `prov_bridge` failure paths and the `fillInputHashesFromDisk` throws are distinguishable in the log: each must record which throw site fired and the offending path.
- [ ] 3.7 Add a test driving a step failure through the body with a capturing `Logger`, asserting the record carries `runId`, `stepId`, `errorClass`, and the underlying error — and that the thrown error is still the scrubbed phrase.

## 4. CLI embedder

- [ ] 4.1 Add a pino → `Logger` adapter at the CLI composition root (`cli/src/modules/harness/`): flip argument order, map `with(fields)` → `child(bindings)`.
- [ ] 4.2 Pass the adapter to `bootHarness` in `cli/src/modules/harness/runtime.ts`, replacing the raw pino logger.
- [ ] 4.3 Pass it into `buildSandboxStepDeps` and `buildExecuteAnalysisDeps` (`cli/src/modules/harness/run_deps.ts`).
- [ ] 4.4 Run `bun run typecheck` in `cli/` and confirm harness records reach the file log tagged `module: "harness"`.

## 5. Sweep the remaining console sites

- [ ] 5.1 `tasks/data-profile.ts` (12) via `DataProfileDeps`.
- [ ] 5.2 `workflows/execute-analysis.ts` (7) via `ExecuteAnalysisDeps`.
- [ ] 5.3 `workflows/execute-target-assessment.ts` (3), `workflows/target-assessment/progress.ts` (2), `phase5-persist.ts` (1), `lib/llm-step.ts` (1).
- [ ] 5.4 `execution/ephemeral-runner.ts` (4), `step-summary.ts` (2), `report-runner.ts` (2), `artifact-metadata.ts` (2).
- [ ] 5.5 `lib/chrome.ts` (5), `state/init.ts` (1), `sandbox/k8s-client.ts` (1).
- [ ] 5.6 `tools/workspace/execute-command.ts` (1), `tools/iterate-report.ts` (1), `tools/bio/search-dgidb.ts` (1). For tools, carry the logger on the tool's factory-closure deps — `ToolContext` stays `{session, signal, emit, runStep}`.
- [ ] 5.7 `lib/otel.ts:77` — convert the TracerProvider `console.log` banner to `logger.debug`, so the CLI's `initTelemetry: () => {}` blocker is removed.
- [ ] 5.8 Confirm zero remaining sites: `grep -rn "console\." src/ --include="*.ts" | grep -v test | grep -v console-logger`.

## 6. Lock it in

- [ ] 6.1 Add `no-console` to `harness/eslint.config.js`, scoped to exempt `src/lib/console-logger.ts` only. Config over per-site disables — no scattered `eslint-disable`.
- [ ] 6.2 Run `bun run lint` and `bun test`; supply a silent/capturing `Logger` wherever tests previously relied on a silent pino.
- [ ] 6.3 Run `tsc -p tsconfig.json` and `bun run format:file` on every touched `src/` file.
- [ ] 6.4 Update `harness/CLAUDE.md`: its DI section names `Logger` as an injected construction dep — make that true, and note the console ban.
- [ ] 6.5 Rewrite the `structured-logging` Purpose prose at sync time — the delta carries requirement operations only, so the paragraph opening "The harness logs operationally through **pino**" is otherwise left stale.
- [ ] 6.6 Note the semver-major in the harness changelog/release notes with the pino-adapter snippet for downstream consumers.

## 7. Follow-ups (not this change)

- [ ] 7.1 Re-enable harness telemetry at the CLI (`initTelemetry: initOtel`) now that the banner is gone, and confirm `cortex.artifact.reconcile.dropped` reports.
- [ ] 7.2 With diagnostics landing, capture a real `lineage_attestation` failure and identify which of the three throw sites fires — then open the change fixing the inotify `IN_OPEN`-as-read misclassification.
