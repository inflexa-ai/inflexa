## Why

The provenance document records *that* the CLI performed an action but never *which model reasoned about it*: an LLM-driven step is attributed to the generic `inflexa:agent-system` SoftwareAgent, indistinguishable from a step where the CLI moved a file. For a product whose positioning rests on open, inspectable provenance, "which intelligence entered the process" is the one fact a reviewer of an AI-assisted analysis most wants — and the resolved model id already exists at the composition root (`comp.model`); it simply never reaches a `prov.*` event. (GitHub issue #68.)

## What Changes

- A new `ProvModelRef` domain type (`provider` kind, resolved model id, and — required on the `openai-compatible` arm only — the endpoint host) is added to the provenance vocabulary.
- `prov.step_completed` and `prov.command_executed` bus events carry the model that drove the activity; the document builders declare a per-distinct-model `prov:SoftwareAgent` (typed `inflexa:Model`), add `wasAssociatedWith(activity, modelAgent)` on step and command activities, and `actedOnBehalfOf(modelAgent, systemAgent)` for the delegation.
- The cli↔harness bridge emitters (`createBusArtifactRegistry`, `createRunProvenanceEmitter`) take the model ref at construction; the boot threads the **resolved** model id (config override or proxy-default resolution) through `RunEngineComposition`.
- No API keys, credentialed URLs, or prompt content are ever recorded — only the model identity.

## Capabilities

### New Capabilities

_None — this extends the existing provenance capabilities._

### Modified Capabilities

- `prov-run-events`: `prov.step_completed` / `prov.command_executed` payloads gain a required `model: ProvModelRef`; the builders additionally record the model agent, its delegation edge, and deterministic model-agent associations on step and command activities.
- `prov-harness-bridge`: the cli realizations of the artifact registry and the run-lifecycle callback stamp the composition's resolved model onto the events they emit.

## Impact

- `cli/src/types/prov.ts`, `cli/src/types/events.ts` — vocabulary + event contract.
- `cli/src/modules/prov/document.ts`, `cli/src/modules/prov/prov.ts` — model-agent builder records, recorder dispatch.
- `cli/src/modules/harness/prov_bridge.ts`, `run_deps.ts`, `runtime.ts` — emitter signatures, composition field, boot wiring.
- `cli/src/lib/bus.ts` — telemetry projection surfaces the model id for the two events.
- No new dependencies; no storage/schema changes (the document remains PROV-JSON on `analyses.provenance`). Replay-idempotency is preserved: model ids are replay-stable within a run, and the association/delegation relation ids fold the agent digest exactly as the existing cli-agent relations do.
