## 1. State layer — observe completion

- [x] 1.1 Add a query to `src/state/step-executions.ts` returning the set of `(runId, stepId)` pairs in an analysis whose `status` is `completed`. Scope it to `WHERE analysis_id = $1 AND status = 'completed'`, which uses the existing `idx_cortex_step_exec_analysis` index (`state/init.ts:102-103`); do not reuse `queryStepsByRun` and filter in memory.
- [x] 1.2 Scope it to the analysis, not the run — the same predicate serves same-run siblings and `prior`-run reads, so one snapshot answers both and `cortex_runs` is never consulted.
- [x] 1.3 Return it as a `ResultAsync<..., DbError>` consistent with the rest of the module. `completed` is the only admissible status — do not widen to "terminal", which would admit `failed`/`canceled`/`skipped` at step level and, via `cortex_runs`, `partial`/`failed`/`canceled` at run level.
- [x] 1.4 Unit-test against the Postgres testcontainer (`withSchema`): rows in each of `running`/`completed`/`failed`/`canceled`/`skipped`/`blocked`, asserting only `completed` pairs return, that pairs from other runs of the SAME analysis are included, and that another analysis's rows are excluded.

## 2. Classification — completion-gated admissibility

- [x] 2.1 Add an explicit inadmissible outcome to the classification result type in `src/provenance/collector.ts`, distinguishable from every `source` value and from a thrown error, carrying the scraped step id so the caller can attribute the rejection.
- [x] 2.2 Extend `classifyReadPath` with a single `completedSteps` parameter — an analysis-scoped set of `(runId, stepId)` pairs. Gate **both** branch 3 (`dependsOn` sibling) and branch 4 (same-run sibling) on membership of `(ownRunId, stepId)`: a declared dependency that has not completed is still inadmissible.
- [x] 2.3 Keep branch 4 admitting a **completed** sibling that is not in `dependsOn` — completion, not declaration, is the gate. Over-tightening to "must be declared" would drop legitimate edges.
- [x] 2.4 Gate branch 5 (`prior`) on membership of the `(runId, stepId)` pair extracted from the path — the same predicate as branches 3 and 4. A prior run's completed step is admissible; a prior run's failed step is not. Do not gate on run-level terminality: `cortex_runs` counts `partial`/`failed`/`canceled` as terminal (`runs.ts:121`), which would admit unfinalized outputs.
- [x] 2.5 Keep `classifyReadPath` pure — `completedSteps` is a parameter, never queried inside. Leave branches 1 and 2 (`data`, `artifacts`) behaviourally unchanged.
- [x] 2.6 Replace the in-code comment at the branch-4 site. The current text ("a read outside dependsOn is still a valid upstream input") is the premise being removed; state instead that a sibling which has not completed has no stable artifact to have been consumed. Do not describe the change itself — write the rationale a fresh reader meets tomorrow.
- [x] 2.7 Make `trackInputAccess`'s no-context fallback fail closed: with no completed-step set available, a same-run sibling path is inadmissible and is not tracked as `upstream`. Absence of the set must never read as "every sibling completed".
- [x] 2.8 Unit-test every branch per the `explicit-input-classification` delta scenarios, including running-sibling, failed-sibling, uncompleted-`dependsOn`, completed-non-dependency, prior-run-completed-step (admitted), and prior-run-failed-step (rejected) cases.

## 3. Frame threading — reject before the collector

- [x] 3.1 Thread the single `completedSteps` set through `FeedExecFrameArgs` in `src/provenance/exec-frame.ts` and pass it to `classifyReadPath` unmodified.
- [x] 3.2 On the inadmissible outcome, skip `trackInputAccess` entirely so the ref never enters the collector and never becomes an attestation target. Do not track-then-drop at reconcile.
- [x] 3.3 Log each rejection through the injected `Logger` seam with the ref path, scraped step id, and that step's observed status as structured fields — identifiers ride as fields, never interpolated into the message.
- [x] 3.4 Add a **new** `lineageEdgeRejected` counter (`cortex.lineage.edge_rejected`) to `src/lib/metrics.ts`, tagged `agent_id`, `step_id`, `reason`, with reasons `producing-step-not-completed` and `snapshot-unavailable`. Leave reconcile's `lineageInputDropped` and its three existing reasons untouched — a counter named for a reconcile-time drop must not be incremented from classification.
- [x] 3.5 Keep `feedExecFrame` best-effort and non-throwing; an all-inadmissible frame still records the command execution.
- [x] 3.6 Unit-test the rejection path, including that the log record and the metric both fire and that the collector's inputs are empty afterwards.
- [x] 3.7 Bind `src/lib/metrics.ts` instruments lazily, following the memoized pattern already used in `src/loop/metrics.ts` and `src/workflows/metrics.ts`. The module currently calls `metrics.getMeter("cortex")` at import (line 12), and it sits in `index.ts`'s static graph, so it evaluates before the embedder calls `initOtel()` (`cli/src/index.ts:15`, after the import at line 12). The OTel metrics API has no proxy upgrade, so every counter in this file — including the two pre-existing ones — binds to a NoopMeter permanently. Without this, the spec's "SHALL increment `lineageEdgeRejected`" is unsatisfiable in production.

## 4. Snapshot the completed set — replay-safe

- [x] 4.1 In `src/tools/workspace/execute-command.ts`, take the snapshot **before** submitting the exec. Submit time is the normative predicate; monotonicity then guarantees every id in it completed before any read the exec performs.
- [x] 4.2 Wrap the snapshot in `ctx.runStep`. This tool is `executionMode: "workflow"` and runs unwrapped in the DBOS workflow body — an unwrapped query re-executes on replay and returns a larger completed-set, producing different lineage for the same run. This is the single most important correctness detail in the change.
- [x] 4.3 On query failure, resolve the durable step to an explicit "snapshot unavailable" outcome rather than throwing — throwing would fail the exec, and provenance must never fail an exec. Do not `unwrapOrThrow` this particular error; return it as a discriminated value from inside the step.
- [x] 4.4 Ensure the degraded outcome is itself checkpointed, so a replay classifies identically instead of succeeding where the original failed. A durable success path with a non-durable failure path reintroduces the determinism hazard through the error branch.
- [x] 4.5 On the degraded path, treat every same-run sibling read as inadmissible, log at error level, and count with `reason: "snapshot-unavailable"`.
- [x] 4.6 Add a workflow-shape test using `setupDbosForTests` asserting that a replayed step classifies against the originally snapshotted set — including a replay of the degraded outcome.

## 5. Thread `dependsOn` to the collector

- [x] 5.1 Add `dependsOn` to `SandboxStepInput` in `src/workflows/sandbox-step.ts`. Verified: the field does not exist and the identifier appears nowhere in that file, so this is a **durable DBOS workflow input shape change**, not a local edit.
- [x] 5.2 Populate it from the plan step where the parent (`executeAnalysis`) starts each child workflow.
- [x] 5.3 Make the field optional and degrade fail-closed when absent, so workflows persisted before this change still recover. Absence must not read as "declared nothing, therefore every sibling is a plain undeclared sibling".
- [x] 5.4 Pass it when constructing `ProvenanceCollector` at `sandbox-step.ts:380-383`. It must not become the admissibility gate — it exists to distinguish a declared edge from an observed one in diagnostics.

## 6. Sandbox image (Go) — narrow capture at the source

- [x] 6.1 Change `buildMountPlan` in `src/sandbox/mount-plan.ts:140` to emit an enumerated `PROVENANCE_WATCH_DIRS`: `/{resourceId}/data`, the step's own `runs/{runId}/{stepId}`, and `runs/{runId}/{siblingStepId}` for every sibling `completed` at sandbox creation. Watch the immutable set, not the declared set — a completed step never writes again, so it cannot churn.
- [x] 6.2 Resolve the completed-sibling list in the caller and pass it into `buildMountPlan` so the plan stays a pure function of its inputs rather than acquiring a hidden database dependency its tests cannot express.
- [x] 6.3 Decouple `PROVENANCE_DATA_PREFIXES` from `PROVENANCE_WATCH_DIRS` in `images/sandbox-base/server/provenance.go:198-199`. The hooks observe only their own process's opens and were never a contamination source, so their prefixes stay at the mount root while inotify narrows.
- [x] 6.4 Update `mount-plan.test.ts`, `docker-client.test.ts`, and `k8s-client.test.ts`, which currently assert `PROVENANCE_WATCH_DIRS === "/an-1"`.
- [x] 6.5 Skip a configured watch dir that does not exist without failing sandbox creation.
- [x] 6.6 In `provenance_inotify_linux.go`, stop reporting a bare `IN_OPEN` as a read — either drop `IN_OPEN` from the watch mask (lines 59-60) or suppress an `IN_OPEN`-derived read when a write/create for the same path was seen in the same exec. Preserve inotify's verification role; the mode-aware hooks remain the authoritative read signal.
- [x] 6.7 Make exhaustion of the **pre-existing** 1000-watch budget (`maxInotifyWatches`) observable to the harness rather than only an in-container `log.Printf` that never reaches the harness log. Silent under-capture is the same blind spot as the silent fabricated edges.
- [x] 6.8 Update the Go tests covering `classifyInotifyMask`, `recordOp`, and prefix derivation.
- [ ] 6.9 Rebuild `sandbox-base` and bump the image version. This phase ships on the image's cadence — phases 1-5 must be independently sufficient for the reported failure so there is no window where lineage is wrong.

## 7. Spec prose not reachable by a delta

- [x] 7.1 Correct the false premise in `openspec/specs/exec-provenance-lineage/spec.md` Purpose (~line 16): "inputs are immutable for the step — the analysis tree is mounted read-only". Read-only bounds only this step's writes; siblings mutate their own read-write directories.
- [x] 7.2 Correct the same claim in `openspec/specs/artifact-manifest/spec.md` Purpose (~lines 26-28).
- [x] 7.3 Confirm the `exec-provenance-lineage` and `sandbox-provenance-tracking` deltas describe `PROVENANCE_WATCH_DIRS` and `PROVENANCE_DATA_PREFIXES` identically — two specs must not define the same env vars differently.

## 8. Verification

- [ ] 8.1 Run `bun run format:file` on every changed file under `src/` (only `src/`, never markdown or specs).
- [ ] 8.2 Run `tsc -p tsconfig.json` and `bun test` from `harness/`.
- [ ] 8.3 Run `openspec validate gate-lineage-on-step-completion --strict`.
- [ ] 8.4 Exercise the package boundary with the `harness:verify` skill, since the CLI does not yet consume this change.
- [ ] 8.5 Reproduce the original failure shape: two concurrent steps where one reads a path under the other's directory, and assert no lineage edge is created in either direction and neither step fails.
- [ ] 8.6 Cover the boundary the design resolves conservatively: a sibling that completes *between* the snapshot and the read is rejected for that exec, and admitted on the step's next exec.

## 9. Follow-up — historical lineage audit (does not gate phases 1-8)

- [ ] 9.1 Write a read-only audit that flags registered `upstream` edges which could not have been admissible, comparing the producing step's `completed_at` against the reading step's execution window in `cortex_step_executions`.
- [ ] 9.2 Run it over existing analyses and report the blast radius. Known instance to expect: run `19110b58`, step `T4S1`, three fabricated edges to `T2S2` (`logs/run_gsea.log`, `output/wikipathways_symbols.gmt`, `scripts/run_gsea.py`).
- [ ] 9.3 Decide with the user whether to purge, annotate, or leave flagged edges. Do not mutate registered provenance without that decision.

## 10. Amendment — scope the watch set to the step's own tree

Dropping `IN_OPEN` (task 6.6) removed inotify's ability to report reads at all, which invalidated the premise of the wider watch set: `data/` and completed siblings are immutable during the step, so they cannot emit the creates, deletes, and moves inotify still collects. They cost budget and yield nothing. Reads of them are captured by the process-local hooks, whose prefixes are configured independently (task 6.3), so narrowing costs no lineage edge.

- [x] 10.1 Set `PROVENANCE_WATCH_DIRS` to the step's own run tree alone in `src/sandbox/mount-plan.ts`, and to empty for a read-only sandbox. It must not contain the mount root, `data/`, or any sibling's tree.
- [x] 10.2 Remove the completed-sibling resolution that scoping made necessary: `resolveCompletedSiblings` in `src/sandbox/create-sandbox.ts`, `CreateSandboxMeta.completedSiblingStepIds`, `buildMountPlan`'s third parameter, and the docker/k8s client threading. Sandbox creation should no longer query step state at all.
- [x] 10.3 Keep `queryCompletedStepsByAnalysis` — it is still the classification snapshot's source (task 4.1). Only the mount-plan caller goes away. Verify no other caller regressed.
- [x] 10.4 Make the inotify watch cap configurable through the environment rather than a bare `const`, defaulting to the existing 1000. A value bounding a walk over user-shaped trees must be raisable without rebuilding the image.
- [x] 10.5 Count and surface a failed `InotifyAddWatch` distinctly from a configured-cap refusal. A kernel `ENOSPC` is currently swallowed by `if err != nil { return nil }`, so the genuine resource failure stays as invisible as it was before task 6.7 — the same blind spot one layer down.
- [x] 10.6 Update the mount-plan, docker-client, k8s-client, create-sandbox, and Go watcher tests to the narrowed scope; delete assertions that depended on siblings or `data/` being watched.
- [x] 10.7 Re-run `tsc`, `bun test`, `go build ./... && go test ./...`, and `openspec validate --strict`.
