## 1. Thread `dependsOn` into the collector

Ordered first deliberately: seeding is behaviourally inert on its own (branch 3 begins matching declared
dependencies that branch 4 already classified identically), but refusing branch 4 before it lands would
delete every legitimate same-run edge.

- [x] 1.1 Add `readonly dependsOn?: readonly string[]` to `SandboxStepInput` in `src/workflows/sandbox-step.ts`, documenting that it is durable DBOS workflow input and that absence is treated as an empty declaration list (fail-closed on recovery)
- [x] 1.2 Seed the step's `ProvenanceCollector` with `dependsOn: [...(input.dependsOn ?? [])]` where it is constructed in `src/workflows/sandbox-step.ts`
- [x] 1.3 Populate `dependsOn` from the plan step's `depends_on` where `execute-analysis.ts` builds the child workflow input
- [x] 1.4 Verify by test that a collector built from a step input carrying `dependsOn: ["qc"]` classifies `runs/{runId}/qc/...` as `upstream` via the declared branch

## 2. Refuse undeclared same-run siblings in classification

- [x] 2.1 Add the `ReadClassification` discriminated result to `src/provenance/collector.ts`: `{ admissible: true, context }` or `{ admissible: false, refRunId?, refStepId? }`
- [x] 2.2 Change `classifyReadPath` to return `ReadClassification`; branches 1, 2, 3 and 5 return `admissible: true` with their existing contexts
- [x] 2.3 Change branch 4 (same-run path that is neither the step's own tree nor a declared dependency) to return `admissible: false`, carrying the scraped step id and `ownRunId` for diagnostics only
- [x] 2.4 Replace branch 4's in-code justification comment — state why an undeclared sibling has no ordering guarantee and why declaration is the available proof of stability, without referencing PR or issue numbers
- [x] 2.5 Update `trackInputAccess` so the no-context fallback tracks nothing when classification refuses, returning `null` for that overload while the explicit-context overload keeps returning `InputRef`
- [x] 2.6 Confirm an absent or empty `dependsOn` refuses every same-run sibling read (fail-closed)

## 3. Honour the refusal at frame ingestion

- [x] 3.1 In `src/provenance/exec-frame.ts`, skip refused reads **before** `trackInputAccess` is called so the path never enters the collector
- [x] 3.2 Log each refusal through the injected `Logger` seam with the read path, `refRunId` and `refStepId`, resolving the logger once outside the read loop
- [x] 3.3 Add the optional `logger` field to `FeedExecFrameArgs`, defaulting to `createNoopLogger()`
- [x] 3.4 Wire the logger through from `execute-command.ts`'s existing `deps.logger` at the `feedExecFrame` call site
- [x] 3.5 Confirm `recordCommandExecution` still runs when every read in a frame is refused

## 4. Correct the false premise in spec prose

Requirement deltas cannot reach Purpose prose, so these two files are edited directly.

- [x] 4.1 Correct `openspec/specs/exec-provenance-lineage/spec.md` Purpose: deferred input hashing is safe because a *declared dependency* has completed and a completed step never writes again — not because the tree is mounted read-only
- [x] 4.2 Correct `openspec/specs/artifact-manifest/spec.md` Purpose (the "inputs are immutable for the step's lifetime" sentence) on the same grounds

## 5. Tests

- [x] 5.1 `collector.test.ts` — one test per classification branch, including a declared dependency whose path is also reachable by branch 4's prefix, guarding against branch-order regression
- [x] 5.2 `collector.test.ts` — an undeclared same-run sibling is refused and carries `refStepId`/`refRunId`
- [x] 5.3 `collector.test.ts` — absent `dependsOn` refuses every same-run sibling
- [x] 5.4 `collector.test.ts` — `trackInputAccess` without context tracks nothing for an inadmissible path
- [x] 5.5 `exec-frame.test.ts` — a refused read calls neither `trackInputAccess` nor produces an `InputRef`, and is logged
- [x] 5.6 `exec-frame.test.ts` — a frame whose every read is refused still records its command with an empty input set and does not throw
- [x] 5.7 Regression test in the shape of the reported failure: a frame reporting a read under a concurrent, undeclared sibling's directory produces no tracked input, so reconcile has nothing to attest when that file later vanishes
- [x] 5.8 Pin the assumption that phantom *writes* are inert — a frame write under a sibling's directory produces no manifest entry, because the manifest is built by walking the step's own write prefix and only tracked inputs are fatal at reconcile
- [x] 5.9 Confirm declared-dependency lineage is unchanged end to end: an `upstream` edge is still tracked, hashed at reconcile, and reaches registration

## 6. Verification

- [x] 6.1 `bun run format:file` on every changed file under `src/`
- [x] 6.2 `tsc -p tsconfig.json` clean
- [x] 6.3 `bun test` green from the `harness/` directory
- [x] 6.4 `openspec validate refuse-undeclared-sibling-lineage-edges --type change --strict` passes
- [x] 6.5 Grep the diff for spec-artifact references (change names, task numbers, issue or PR numbers) in code comments and remove any found
