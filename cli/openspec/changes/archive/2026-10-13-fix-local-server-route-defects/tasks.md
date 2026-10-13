# Tasks

Write each test before its fix. Run the test, and make sure that it fails for the reason under test. Then do the fix.

## 1. The lineage hash reference (D1)

- [x] 1.1 In `src/modules/prov/lineage.test.ts`, add tests with fixture hashes of the form `sha256:<64 hex>` for each new scenario of the `prov-lineage` delta. Make sure that each new test fails before the fix:
  - a bare 8-character hex prefix resolves, and the same prefix after `sha256:` resolves
  - the bare full digest resolves
  - `sha256`, `sha256:`, and `sha256:` with 5 hex characters match no file by hash
  - a bare hex prefix that two digests share fails with `ambiguous_hash`
  - the tree label shows the first 12 digest characters, and that short hash resolves
  - the dot label and the mermaid label show the same 12 digest characters, with no `sha256:`
- [x] 1.2 Change `resolveLineageRef` and `shortHash` in `src/modules/prov/lineage.ts` as D1 tells. Make sure that `lineage.test.ts` and `src/server/routes/provenance.test.ts` pass, also the tests with fixture hashes that have no colon.

## 2. The sandbox readiness read (D2)

- [x] 2.1 Add tests, and make sure that each one fails before the fix:
  - In `src/modules/libs/composition.test.ts`, record a farm failure with the no-catalog composition. Then a peek gives the record two times, and a take gives it and clears it.
  - In `src/server/sandbox_gate.test.ts`, the gate takes the record when it reads the machine, and it refuses with the taken reason. A refusal for a live transfer does not take the record.
  - In `src/server/sandbox_gate.test.ts`, the scenario "A readiness read leaves the farm failure for the gate". Record a farm failure. Call the real `readSandboxReadiness` two times, with `SandboxReadinessOpts` that give a present image and an installed store. Each call gives the failure in `farm.failure`. Then call `sandboxRefusal` with `readiness` set to that same `readSandboxReadiness` call and the real `readFarmFailure`. The refusal names the failure. Then `readSandboxReadiness` gives `farm.failure` as `null`.
- [x] 2.2 Add `peekFarmCompositionFailure` to `src/modules/libs/composition.ts`. Use it in `readSandboxReadiness`, add `SandboxReadinessOpts` to `readSandboxReadiness`, and add `readFarmFailure` to `SandboxGateOpts`, as D2 tells. Make sure that the tests of 2.1, `sandbox_gate.test.ts`, `src/server/routes/runs.test.ts`, and `src/server/profile_queue.test.ts` pass.
- [x] 2.3 Correct the comments that say the readiness read consumes the record: `src/api/runs.ts` (`farm.failure`), `src/tui/hooks/sandbox_gate.tsx`, and the JSDoc of `readSandboxReadiness` and `sandboxRefusal`. Make sure that `rg -n "consum" src/server/sandbox_gate.ts src/api/runs.ts src/tui/hooks/sandbox_gate.tsx` shows no stale claim.

- [x] 2.4 In `src/lib/config.test.ts`, add a test: with no runtime selected and a probe that succeeds, the new read gives the runtime and the configuration has no `runtime` key after it. Make sure that the test fails before the fix. Then add the read to `src/lib/config.ts`, use it in `ensureRuntime` and in `imageReadiness`, as D2 tells. Make sure that `config.test.ts` and `sandbox_gate.test.ts` pass.

## 3. The input removal route (D3)

- [x] 3.1 In `src/server/routes/analyses.test.ts`, add the test of the scenario "One failed removal keeps the others". Use four matched inputs. Use a `removeInput` member of `AnalysisRouteOpts` that fails for the second input and the third input. For the first input and the fourth input, it calls the real `removeInput`. Assert the 500 `internal_error`, a message that names the two failed inputs and the two removed inputs, the remaining rows, and the `prov.input_removed` events. Make sure that the test fails before the fix.
- [x] 3.2 Add `removeInput` to `AnalysisRouteOpts` and `DEFAULT_ANALYSIS_ROUTE_OPTS`, and change `POST {A}/inputs/remove` as D3 tells. Make sure that `analyses.test.ts`, `src/tui/remove_inputs_dialog.render.test.tsx`, and `src/client/commands/analyses.test.ts` pass.

## 4. The busy read of the TUI (D4)

- [x] 4.1 In `src/tui/commands.test.ts`, add tests that the busy read of `analysis.rename` and of `analysis.delete` sends `touch=false`. Use the request spy of the `view.status` test. Make sure that each test fails before the fix.
- [x] 4.2 Pass `touch: false` in `workspaceBusyReason` (`src/tui/commands.tsx`). Make sure that the tests of 4.1 and `commands.test.ts` pass.

## 5. The other removal surfaces and the gate of the input change (D5, D6)

- [x] 5.1 Add tests, and make sure that each one fails before the fix:
  - In `src/modules/harness/inputs_tool.test.ts`, a `remove` of four inputs, with a `removeInput` option that fails for the second input and the third input. The tool gives `status: "error"`, and the message names the two failed inputs and the two removed inputs.
  - In `src/server/routes/analyses.test.ts`, a `PUT {A}/inputs` that removes the same four inputs. The route answers 500 `internal_error`, and the message names the two failed inputs and the two removed inputs.
  - In `src/server/sandbox_gate.test.ts`, the gate of the input change refuses two times with a recorded farm failure. Then the default gate still names it.
- [x] 5.2 Add `ManageInputsToolOpts` to `src/modules/harness/inputs_tool.ts`, the removal option to `applyInputsDiff`, and `INPUT_DRIFT_SANDBOX_GATE_OPTS` to `src/server/sandbox_gate.ts`, as D5 and D6 tell. Make sure that the tests of 5.1 and `src/server/profile_queue.test.ts` pass.

## 6. Verification

- [x] 6.1 Run `bun run format:file` on each changed file in `src/`. Make sure that `bun run typecheck` and `bun run lint` pass, and that each changed test file passes.
- [x] 6.2 The coordinator runs the full `cli` suite (`bun run test`) one time, after the reviews. The implementor does not run the full suite. Make sure that only the known `packaging` parity test of `composition.test.ts` fails, for its environment reason.
