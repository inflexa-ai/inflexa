## 1. Vocabulary and event contract

- [x] 1.1 Add `ProvModelRef` to `src/types/prov.ts` — the discriminated union `{ provider: "anthropic"; model } | { provider: "openai-compatible"; model; endpoint? }` with JSDoc stating the resolved-id and no-credentials rules (design D1)
- [x] 1.2 Add the required `model: ProvModelRef` field to `prov.step_completed` and `prov.command_executed` in `src/types/events.ts` (design D2)
- [x] 1.3 Surface `model` (the id) in the bus telemetry projection for both events in `src/lib/bus.ts`

## 2. Document builders

- [x] 2.1 Add the model-agent append helper to `src/modules/prov/document.ts`: deterministic QName `inflexa:agent-model-{digest(provider|model|endpoint)}`, dual `prov:type` (`prov:SoftwareAgent` + `inflexa:Model`), `prov:label`, `inflexa:provider`/`inflexa:model`/`inflexa:endpoint?`, plus the `actedOnBehalfOf(modelQn, responsibleQn)` delegation under `delegation-{modelDigest}-{responsibleDigest}` (design D3, D4)
- [x] 2.2 Extend `appendStepCompleted` to take the model ref and add `wasAssociatedWith(stepQn, modelQn)` under the existing `assoc-step-…-{agentDigest}` template (design D4)
- [x] 2.3 Extend `appendCommandExecuted` to take the model ref and add `wasAssociatedWith(cmdQn, modelQn)` under the existing `assoc-cmd-…-{agentDigest}` template (design D4)
- [x] 2.4 Pass `event.model` through the recorder dispatch in `src/modules/prov/prov.ts`

## 3. Bridge and boot wiring

- [x] 3.1 `createBusArtifactRegistry(model: ProvModelRef)` and `createRunProvenanceEmitter(model: ProvModelRef)` in `src/modules/harness/prov_bridge.ts` stamp the ref onto `prov.command_executed` / `prov.step_completed`
- [x] 3.2 Add `modelRef: ProvModelRef` to `RunEngineComposition` (invariant: `modelRef.model === model`) and thread it through `buildSandboxStepDeps` / `buildExecuteAnalysisDeps` in `src/modules/harness/run_deps.ts` (design D5)
- [x] 3.3 Construct the ref at boot in `src/modules/harness/runtime.ts` from the resolved model id and the `anthropic` provider kind the boot wires

## 4. Tests and verification

- [x] 4.1 Builder tests in `src/modules/prov/prov.test.ts`: dual-association step/command, single agent + delegation across activities, endpoint attribute only on `openai-compatible`, re-emission dedup under `unified()`
- [x] 4.2 Bridge tests in `src/modules/harness/prov_bridge.test.ts`: emitted events carry the construction-time ref
- [x] 4.3 Wiring tests in `src/modules/harness/run_deps.test.ts` (and `runtime.test.ts` if it constructs the composition)
- [x] 4.4 `bun run format:file` on changed src files; `bun run typecheck`; `bun run lint`; full `bun test` pass
