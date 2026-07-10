## Context

`ProvActor` is a three-way union (`user` / `anonymous` / `system`); every execution activity (run, step, command) is `wasAssociatedWith` the system agent — the CLI itself, stamped with its version and commit. The model id that actually drove an LLM step exists at the composition root: boot resolves it (config override, or the proxy's `/models` default via `resolveModelId`) into `RunEngineComposition.model`, and threads it into every harness seat (chat / decision / synthesis all resolve to the one config id today — the harness's D6). The two provenance emit sites — `createBusArtifactRegistry` (command/file/input events) and `createRunProvenanceEmitter` (run/step lifecycle events) — are built from that composition, so the model is one field away from the events and never crosses.

Constraints inherited from the existing prov design: records must be replay-idempotent (DBOS re-executes workflow bodies on recovery, so every element QName and relation id must be deterministic, and agent-bearing relation ids fold an agent digest because a recovery boot can re-derive a *different* agent); the recorder never infers facts across events (each event carries what its builder needs); the harness stays tsprov-free and bus-free.

## Goals / Non-Goals

**Goals:**

- Record which model reasoned about each model-driven step and command activity, as a first-class PROV `SoftwareAgent` related by `wasAssociatedWith`, with `actedOnBehalfOf` expressing the model→CLI delegation.
- Record the **resolved** model id (never the config's `null`), the provider kind, and — for `openai-compatible` only — the endpoint host.
- Preserve replay-idempotency: re-emission under recovery merges to one record set.

**Non-Goals:**

- Recording API keys, credentialed URLs, or prompt content (explicitly excluded by the issue).
- Recording the model id echoed back in provider responses (proxy-substitution detection) — we record the id we *requested*; response-echo capture would require a harness-side change to surface response metadata through the agent loop and is out of scope.
- Per-seat model splitting — chat/decision/synthesis resolve to one config id today (D6); the design accommodates a future split (each emitter takes its own ref at construction) without recording a seat distinction now.
- Model attribution for run-level activities and file entities — the issue scopes `wasAssociatedWith(modelAgent)` to the step and command activities the model drove; files stay attributed to the system agent, and the run activity keeps its existing CLI association.
- Container image digests, environment, seeds, tool versions (separate issues per #68).

## Decisions

**D1 — `ProvModelRef` is a discriminated union over the two native provider kinds, with `endpoint` REQUIRED on the `openai-compatible` arm.**
`{ provider: "anthropic"; model } | { provider: "openai-compatible"; model; endpoint }` — the type itself enforces the issue's "endpoint only for openai-compatible, host only, never a key" rule instead of a prose convention. The two kinds mirror the harness's native provider configs (`harness/src/providers/ai-sdk.ts`); note `provider` records the native kind (the protocol the model was reached through), not the model's vendor — the model id carries that. Endpoint is required, not optional, on its arm: the harness's openai-compatible config always carries a `baseURL`, and an optional field would let a future host silently omit the arm's most load-bearing fact — then split the agent's identity (the endpoint keys the QName, D3) when the omission is fixed. The CLI's chat path is `createAnthropicProvider` against the local proxy, so today's wiring always stamps `anthropic` and no endpoint; the `openai-compatible` arm is exercised by tests and ready for a host that wires it.

**D2 — The model rides the `prov.step_completed` and `prov.command_executed` events (required field), not a separate event or cross-event inference.**
The recorder never infers facts across events (established by `generation: "command" | "step"` riding `prov.file_written`). A required field makes "forgot to wire the model" a compile error at both emit sites, which both hold the composition. Rejected: an optional field (silent gaps in exactly the record this change exists to make), a per-run `prov.model_resolved` event (cross-event inference in the recorder, plus a run-scoped cache keyed by runId that recovery ordering could leave cold).

**D3 — One model agent per distinct `(provider, model[, endpoint])`, QName `inflexa:agent-model-{digest}`.**
The digest is `Bun.hash` over the JSON-encoded identity tuple, in base-36. JSON-encoded rather than `|`-joined (the existing path digests' style) because model ids and endpoint hosts are free-form config strings — nothing structurally excludes a delimiter inside a field, and a structural encoding makes cross-field collisions impossible (the path digests are safe because their hash side is hex). Endpoint is folded into identity so the same model id reached through two different endpoints yields two agents (a local endpoint is itself meaningful provenance) rather than one agent with contradictory endpoint attributes. Attributes: `prov:type` = both `prov:SoftwareAgent` and `inflexa:Model` (tsprov attributes are multi-valued), `prov:label` = the model id, `inflexa:provider`, `inflexa:model`, and `inflexa:endpoint` on the openai-compatible arm.

**D4 — Association and delegation relations reuse the existing deterministic-id scheme.**
`wasAssociatedWith(stepQn, modelQn)` gets id `assoc-step-{runId}-{stepId}-{agentDigest(modelQn)}` and `wasAssociatedWith(cmdQn, modelQn)` gets `assoc-cmd-{runId}-{stepId}-{groupDigest}-{agentDigest(modelQn)}` — the *same* id templates the CLI-agent associations use, disambiguated by the agent digest exactly as those are (two agents on one activity produce two ids; re-emission of the same pair dedups). `actedOnBehalfOf(modelQn, responsibleQn)` gets `delegation-{agentDigest(modelQn)}-{agentDigest(responsibleQn)}` — keyed on the full endpoint tuple, activity-independent (the delegation holds for the pair, not per activity), declared beside every model-agent declaration and collapsed by `unified()`. If a recovery boot auto-resolves a *different* default model, the re-emitted records carry a second agent and second association — the same honest-drift semantics the agent-digest fold already accepts for a CLI upgrade mid-run.

**D5 — The composition carries `modelRef: ProvModelRef` as its ONE model field, built at boot beside the provider constructor.**
Boot is the only site that knows both the resolved id and the provider kind (it calls `createAnthropicProvider`), so it constructs the ref — directly adjacent to that constructor, so the recorded kind can never silently diverge from the wiring (the harness does not expose the kind type-level; adjacency is the coupling). `run_deps.ts` passes the ref to the two emitter constructors, and the harness seats read the bare id off `modelRef.model`. Rejected: carrying `model: string` beside `modelRef` (two sources of truth whose divergence compiles fine and produces a signed document that attributes steps to a model that did not drive them — exactly the record this change exists to make trustworthy) and hardcoding `"anthropic"` in `run_deps.ts` (the provider kind is boot knowledge, not dep-assembly knowledge).

## Risks / Trade-offs

- [Proxy opacity] The recorded id is what the CLI asked for; CLIProxyAPI could substitute silently → accepted and documented (Non-Goal); response-echo capture is a harness-side follow-up.
- [Default-model drift across recovery boots] A run recovered on a boot whose proxy default changed re-emits records under a second model agent → both agents appear with their associations; this mirrors the accepted CLI-upgrade drift and is more honest than pretending one model ran everything.
- [Provider-kind vocabulary drift] `ProvModelRef`'s two kinds re-state the harness's `AiSdkProviderConfig["kind"]` union as fresh literals (the harness barrel does not export it) → accepted; tying the types needs a harness-first export, noted as a follow-up.

## Open Questions

_None — the issue's design questions (seats, resolution timing, proxy opacity, determinism) are settled above._
