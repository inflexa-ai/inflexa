# Design — fix-model-review-findings

## Context

Four findings from the PR #70 review of the `record-model-agent` branch. The load-bearing one:
`runtime.ts`'s `swapSandboxEmitters` (runtime.ts:702) re-stamps the sandbox provenance emitters on
a live model switch by mutating `readonly` fields — through `as`-casts — on the deps objects the
harness's registered DBOS workflows closed over at registration. That works only because the
harness happens to dereference `deps.emitProvenance` (execute-analysis.ts:277, inside
`emitProvenanceGuarded`) and `deps.artifactRegistry` (sandbox-step.ts:740) freshly per invocation
— an unspoken implementation coincidence. A harness refactor that snapshots either field at
registration (`const { emitProvenance } = deps`) would make signed provenance silently attest the
OLD model after every live switch, with all tests green: `agent_switch.test.ts` fakes
`swapSandboxEmitters` with a local variable, so the real mutation-to-read path has zero coverage.

The second finding: for a `direct` + `anthropic` connection, the chat path builds
`{baseURL}/messages` (`@ai-sdk/anthropic` appends `/messages`; its own default baseURL is
`https://api.anthropic.com/v1`), while `model_listing.ts`'s anthropic branch builds
`{baseURL}/v1/models` and documents the opposite convention (baseURL *without* `/v1`). No single
configured value satisfies both: the `/v1` form breaks listing (degrades to free text), the bare
form breaks chat (404). Findings three and four are cosmetic (a stale doc comment in
`types/prov.ts`; two imports stranded below an `afterEach` in `profile_trigger.test.ts`).

## Goals / Non-Goals

**Goals:**
- Make the live emitter swap structurally immune to the consumer's read discipline — the same
  guarantee the chat provider's `SwappableChatProvider` handle already gives.
- Delete the `capturedExecuteAnalysisDeps` capture and both `as`-casts from `runtime.ts`.
- One baseURL convention for direct-anthropic serving both chat and listing.
- Regression coverage that pins swap-effectiveness under a snapshot-at-registration consumer.

**Non-Goals:**
- No `harness/` changes. The deps fields are plain interface/function types
  (`ArtifactRegistry { register, sync }`; `emitProvenance?: (event) => void`); a delegating
  implementation satisfies them verbatim, so the fix needs no new harness API, no spec'd
  lazy-read contract, and no change to workflow registration.
- No behavior change to switch timing, the idle gate, pending semantics, or the events' shape.
- No caching or convention change for the OpenAI-compatible or cliproxy listing paths (both are
  already self-consistent).

## Decisions

### D1 — Stable delegating emitter handles, injected once (the SwappableChatProvider pattern)

`prov_bridge.ts` gains `createSwappableSandboxEmitters(initialName: ProvModelId)` returning a
holder:

```ts
type SwappableSandboxEmitters = {
    /** Stable ArtifactRegistry the deps bundles inject — delegates register AND sync to the current inner. */
    readonly artifactRegistry: ArtifactRegistry;
    /** Stable run-provenance emitter fn the deps bundles inject — delegates to the current inner. */
    readonly emitProvenance: (event: RunProvenanceEvent) => void;
    /** Rebuild both inners WITH `name` (construction-time stamping preserved) and re-point delegation. */
    swap(name: ProvModelId): void;
};
```

Internally it holds `let registry = createBusArtifactRegistry(name)` and
`let emitter = createRunProvenanceEmitter(name)`; the exposed `artifactRegistry` forwards
`register`/`sync` to the *current* `registry` at call time, `emitProvenance` forwards to the
*current* `emitter`. Consumers capture the stable outer objects; `swap` replaces only the
cli-owned inners.

Why here and not `agent_switch.ts`: the holder is emitter-domain composition (it pairs the two
prov-bridge constructors), while `agent_switch.ts` owns *when* swaps happen. The switch keeps
calling a boot-supplied `swapSandboxEmitters(name)` — its wiring type is unchanged; only the
boot's realization becomes `emitters.swap(name)`.

Alternatives rejected: a harness-exported rebind API (API growth for something injection already
solves; violates nothing to leave out), a spec'd lazy-read guarantee on the harness (documents a
constraint on the consumer instead of removing the dependency on it), test-only pinning (leaves
the `as`-casts and the unspoken contract in place).

### D2 — The composition carries the holder's stable fields; builders stop constructing emitters

`RunEngineComposition` carries the boot-built holder (or its two stable fields);
`buildSandboxStepDeps` and `buildExecuteAnalysisDeps` inject `comp.…artifactRegistry` /
`comp.…emitProvenance` instead of calling `createBusArtifactRegistry(...)` /
`createRunProvenanceEmitter(...)` themselves. This deletes the reason `runtime.ts` captured
`capturedExecuteAnalysisDeps` (it existed only to reach the built bundle's field later) and both
`as`-casts. The `{provider}/{model}` name is composed once at the holder's construction/swap —
`run_deps.ts` no longer composes it inline.

### D3 — The anthropic listing derives from the chat baseURL verbatim

`model_listing.ts`'s anthropic branch becomes `{baseURL}/models` (headers unchanged: `x-api-key`
+ `anthropic-version`), matching Anthropic's List Models route when `baseURL` is the
`/v1`-terminated root the chat path requires. The branch comment now states the convention
positively (baseURL includes `/v1`; the same value serves `POST {baseURL}/messages` and
`GET {baseURL}/models`) instead of documenting the wrong assumption. Setup's
`promptDirectConnection` endpoint prompt gains the anthropic example
(`https://api.anthropic.com/v1`) in its placeholder/validation copy so users author the working
form. Tests in `model_listing.test.ts` pin the new URL.

### D4 — Regression test proves snapshot-safety through the real bundles

A test (in `run_deps.test.ts` or `agent_switch.test.ts`) drives the REAL path: build
`buildExecuteAnalysisDeps` over a composition carrying real swappable emitters, then simulate the
worst-case consumer — capture `deps.emitProvenance` into a local `const` (exactly what a
snapshot-at-registration harness refactor would do), call `swap(newName)`, emit a
`step_completed` through the captured reference, and assert the bus event's `model` is the NEW
name. Mirror for `artifactRegistry` (capture, swap, `register`, assert the
`prov.command_executed` name). This is the coverage the review found missing: the fake-swap tests
prove the controller's timing; these prove the injection's effectiveness.

## Risks / Trade-offs

- [Delegation adds one indirection per emit/register call] → Negligible: both are per-step
  (not per-token) paths, and the chat provider already pays the identical pattern per request.
- [`swap` and an in-flight `register` could interleave] → Same exposure as today's field
  mutation, and the idle gate already guarantees no sandbox work is in flight when `swap` runs;
  the delegator reads the inner at call time, so even a straggler gets a coherent (new) emitter,
  never a torn state.
- [A future third emitter added to the deps bundles could bypass the holder] → The holder is the
  single construction point for sandbox emitters in `run_deps.ts`; constructing one inline would
  have to ignore the composition field that sits right there, and the spec scenario
  ("consumer that snapshots its deps still observes the swap") fails in review.
- [Anthropic listing URL change breaks a user who configured the bare-root baseURL] → That
  configuration never had working chat (its `POST …/messages` 404s), so no working setup
  regresses; the setup prompt now steers to the `/v1` form.

## Migration Plan

Pure in-place fix on the `record-model-agent` branch (pre-merge): no persisted-data change, no
config-shape change, no rollback concern beyond `git revert`. Existing `models.connection`
blocks are untouched — only consumers of `baseURL` change.
