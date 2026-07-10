## 1. Vocabulary and event contract

- [x] 1.1 Add `ProvModelId` to `src/types/prov.ts` — the opaque verbatim-captured resolved id, with JSDoc stating the resolved-id, model-agnostic, and no-credentials rules (design D1)
- [x] 1.2 Add the required `model: ProvModelId` field to `prov.step_completed` and `prov.command_executed` in `src/types/events.ts` (design D2)
- [x] 1.3 Surface `model` (the id) in the bus telemetry projection for both events in `src/lib/bus.ts`

## 2. Document builders

- [x] 2.1 Add the model-agent append helper to `src/modules/prov/document.ts`: deterministic QName `inflexa:agent-model-{digest(id)}`, dual `prov:type` (`prov:SoftwareAgent` + `inflexa:Model`), `prov:label`, `inflexa:model`, the `actedOnBehalfOf(modelQn, responsibleQn)` delegation under `delegation-{modelDigest}-{responsibleDigest}`, and the model association on the driven activity (design D3, D4)
- [x] 2.2 Extend `appendStepCompleted` to take the model ref and add `wasAssociatedWith(stepQn, modelQn)` under the existing `assoc-step-…-{agentDigest}` template (design D4)
- [x] 2.3 Extend `appendCommandExecuted` to take the model ref and add `wasAssociatedWith(cmdQn, modelQn)` under the existing `assoc-cmd-…-{agentDigest}` template (design D4)
- [x] 2.4 Pass `event.model` through the recorder dispatch in `src/modules/prov/prov.ts`

## 3. Bridge and boot wiring

- [x] 3.1 `createBusArtifactRegistry(model: ProvModelId)` and `createRunProvenanceEmitter(model: ProvModelId)` in `src/modules/harness/prov_bridge.ts` stamp the id onto `prov.command_executed` / `prov.step_completed`
- [x] 3.2 Feed the composition's ONE `model: ProvModelId` field to both `buildSandboxStepDeps` / `buildExecuteAnalysisDeps` emitter constructions in `src/modules/harness/run_deps.ts` (design D5)
- [x] 3.3 Thread the boot-resolved model id into the composition in `src/modules/harness/runtime.ts`

## 4. Tests and verification

- [x] 4.1 Builder tests in `src/modules/prov/prov.test.ts`: dual-association step/command, single agent + delegation across activities, verbatim capture (incl. vendor-qualified ids), re-emission dedup under `unified()`
- [x] 4.2 Bridge tests in `src/modules/harness/prov_bridge.test.ts`: emitted events carry the construction-time ref
- [x] 4.3 Wiring tests in `src/modules/harness/run_deps.test.ts` (and `runtime.test.ts` if it constructs the composition)
- [x] 4.4 `bun run format:file` on changed src files; `bun run typecheck`; `bun run lint`; full `bun test` pass
