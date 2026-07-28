## 1. DAG snapshot correctness

- [x] 1.1 Change `emitDagSnapshot` in `src/workflows/execute-analysis.ts` to populate `name` by joining `input.planStepById` (NOT `input.steps`, which is the scheduler's `{id, depends_on}` projection); leave `id`, `dependsOn`, `agent`, `status`, and `level` unchanged
- [x] 1.2 Confirm `artifactCount` and `summary` remain omitted rather than defaulted, and note in the mapper why
- [x] 1.3 Add a test asserting a snapshot step carries the plan name in `name` and the slug in `id`, and that a step lacking a plan name does not fall back to the id silently

## 2. Run-observation seam

- [x] 2.1 Define the snapshot payload type (run id, run lifecycle status, and per-step id / name / agent / status / optional durationMs / optional error) beside `RunProvenanceEvent`, exported from the barrel — no derived aggregates: run duration and completion counts stay on the ledger row so the payload cannot disagree with it
- [x] 2.2 Add the optional `observeRun` dep to `ExecuteAnalysisDeps` with a `void` return type, documenting the synchronous-by-signature contract and its independence from `emitProvenance`
- [x] 2.3 Add an `observeRunGuarded` invoker mirroring `emitProvenanceGuarded` (log-and-swallow, run id in the log fields, its own logger namespace) — deliberately not shared with the provenance guard
- [x] 2.4 Invoke the guard from the run-start boundary, from all eight existing `emitDagSnapshot()` call sites, and from the terminal boundary — reusing the snapshot the DAG emitter already builds rather than constructing a second projection
- [x] 2.5 Verify no invocation is wrapped in `DBOS.runStep`, so body re-execution re-fires the sequence
- [x] 2.6 Test: a run with no `observeRun` behaves identically to one with it; supplying only one of the two seams leaves the other uninvoked
- [x] 2.7 Test: every plan step appears in every snapshot, including not-yet-dispatched steps
- [x] 2.8 Test: a throwing observer is logged with the run id and the run still reaches its normal terminal status
- [x] 2.9 Test: replaying the body re-delivers the snapshot sequence and a latest-snapshot consumer lands in the same state

## 3. Public synthetic-message primitives

- [x] 3.1 Export `syntheticUserMessage` and `isSyntheticUserMessage` from `src/index.ts`
- [x] 3.2 Widen the rationale prose in `src/memory/thread-history.ts` and `src/memory/ai-sdk-message-storage.ts` from loop-authored to loop-or-host-authored, without touching `isGenuineUserStart` or `GENUINE_USER_START_SQL`
- [x] 3.3 Test: a host-appended synthetic message does not open a turn for display paging or for the token window
- [x] 3.4 Test: `retractLastTurn` removes a synthetic message that falls inside the retracted turn, and leaves one insulated by a later genuine turn
- [x] 3.5 Test: a host-appended synthetic message is present in the messages assembled for the next turn

## 4. Contract and documentation sweep

- [x] 4.1 Verify the barrel exports compile against a consumer that imports only from `@inflexa-ai/harness` (no deep imports, no DBOS SDK)
- [x] 4.2 Run `openspec validate add-run-observation-seams` and the harness test suite
- [x] 4.3 Confirm nothing in this change reads the DBOS `"events"` stream, touches `prepareChatTurn` / `assembleMessages`, or alters any cancellation path — keeping the #247, #248, and #250 boundaries intact
