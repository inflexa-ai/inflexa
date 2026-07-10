## Context

`ProvActor` is a three-way union (`user` / `anonymous` / `system`); every execution activity (run, step, command) is `wasAssociatedWith` the system agent — the CLI itself, stamped with its version and commit. The model id that actually drove an LLM step exists at the composition root: boot resolves it (config override, or the proxy's `/models` default via `resolveModelId`) into `RunEngineComposition.model`, and threads it into every harness seat (chat / decision / synthesis all resolve to the one config id today — the harness's D6). The two provenance emit sites — `createBusArtifactRegistry` (command/file/input events) and `createRunProvenanceEmitter` (run/step lifecycle events) — are built from that composition, so the model is one field away from the events and never crosses.

Constraints inherited from the existing prov design: records must be replay-idempotent (DBOS re-executes workflow bodies on recovery, so every element QName and relation id must be deterministic, and agent-bearing relation ids fold an agent digest because a recovery boot can re-derive a *different* agent); the recorder never infers facts across events (each event carries what its builder needs); the harness stays tsprov-free and bus-free.

## Goals / Non-Goals

**Goals:**

- Record which model reasoned about each model-driven step and command activity, as a first-class PROV `SoftwareAgent` related by `wasAssociatedWith`, with `actedOnBehalfOf` expressing the model→CLI delegation.
- Record the **resolved** model id (never the config's `null`), captured verbatim as an opaque string — model-agnostic by construction.
- Preserve replay-idempotency: re-emission under recovery merges to one record set.

**Non-Goals:**

- Recording API keys, credentialed URLs, or prompt content (explicitly excluded by the issue).
- Recording the model id echoed back in provider responses (proxy-substitution detection) — we record the id we *requested*; response-echo capture would require a harness-side change to surface response metadata through the agent loop and is out of scope.
- Per-seat model splitting — chat/decision/synthesis resolve to one config id today (D6); the design accommodates a future split (each emitter takes its own ref at construction) without recording a seat distinction now.
- Model attribution for run-level activities and file entities — the issue scopes `wasAssociatedWith(modelAgent)` to the step and command activities the model drove; files stay attributed to the system agent, and the run activity keeps its existing CLI association.
- Container image digests, environment, seeds, tool versions (separate issues per #68).

## Decisions

**D1 — `ProvModelId` is an opaque string: the resolved model id, captured verbatim.**
PR review (#70) removed the earlier discriminated union over the harness's native provider kinds and its per-kind endpoint host: the reviewer's point stands that provenance should capture *whatever is set up*, model-agnostically, rather than maintain a provider vocabulary of its own — and the endpoint was populated by no production wiring (the CLI reaches models through the local proxy, whose host is plumbing, not the model's home). The id records verbatim: a bare proxy id as-is, and a vendor-qualified `{provider}/{model}` name (the Mastra/Bifrost convention) as-is if the host's model config adopts it — nothing is inferred or parsed from it. Rejected: vendor-prefixing bare ids by inference (fabricates provenance from id-substring heuristics) and keeping the native-kind union (a closed vocabulary the cli must keep in step with the harness for marginal audit value).

**D2 — The model rides the `prov.step_completed` and `prov.command_executed` events (required field), not a separate event or cross-event inference.**
The recorder never infers facts across events (established by `generation: "command" | "step"` riding `prov.file_written`). A required field makes "forgot to wire the model" a compile error at both emit sites, which both hold the composition. Rejected: an optional field (silent gaps in exactly the record this change exists to make), a per-run `prov.model_resolved` event (cross-event inference in the recorder, plus a run-scoped cache keyed by runId that recovery ordering could leave cold).

**D3 — One model agent per distinct model id, QName `inflexa:agent-model-{digest(id)}`.**
The digest is `Bun.hash` over the verbatim id, in base-36 — a single opaque field, so there is no multi-field tuple to encode and no cross-field collision surface. Attributes: `prov:type` = both `prov:SoftwareAgent` and `inflexa:Model` (tsprov attributes are multi-valued), `prov:label` = the id, and `inflexa:model` = the id — the agent's only identity attribute.

**D4 — Association and delegation relations reuse the existing deterministic-id scheme.**
`wasAssociatedWith(stepQn, modelQn)` gets id `assoc-step-{runId}-{stepId}-{agentDigest(modelQn)}` and `wasAssociatedWith(cmdQn, modelQn)` gets `assoc-cmd-{runId}-{stepId}-{groupDigest}-{agentDigest(modelQn)}` — the *same* id templates the CLI-agent associations use, disambiguated by the agent digest exactly as those are (two agents on one activity produce two ids; re-emission of the same pair dedups). `actedOnBehalfOf(modelQn, responsibleQn)` gets `delegation-{agentDigest(modelQn)}-{agentDigest(responsibleQn)}` — keyed on the full endpoint tuple, activity-independent (the delegation holds for the pair, not per activity), declared beside every model-agent declaration and collapsed by `unified()`. If a recovery boot auto-resolves a *different* default model, the re-emitted records carry a second agent and second association — the same honest-drift semantics the agent-digest fold already accepts for a CLI upgrade mid-run.

**D5 — The composition's ONE `model: ProvModelId` field feeds the seats and the emitters alike.**
With the record reduced to the id (D1), the composition's existing resolved-id field IS the provenance value: `run_deps.ts` passes `comp.model` to the two emitter constructors, and the harness seats read the same field. One field means the seats and the signed provenance record can never be fed diverging values. Rejected: a parallel `modelRef` field (two sources of truth whose divergence compiles fine and produces a signed document that attributes steps to a model that did not drive them — exactly the record this change exists to make trustworthy).

## Risks / Trade-offs

- [Proxy opacity] The recorded id is what the CLI asked for; CLIProxyAPI could substitute silently → accepted and documented (Non-Goal); response-echo capture is a harness-side follow-up.
- [Default-model drift across recovery boots] A run recovered on a boot whose proxy default changed re-emits records under a second model agent → both agents appear with their associations; this mirrors the accepted CLI-upgrade drift and is more honest than pretending one model ran everything.
- [No provider/endpoint facts] the record is the id alone; which route or endpoint served it is not captured → deliberate (PR #70 review): the id is the load-bearing fact, and any wiring fact worth recording later lands harness-first without touching the event shape.

## Open Questions

_None — the issue's design questions (seats, resolution timing, proxy opacity, determinism) are settled above._
