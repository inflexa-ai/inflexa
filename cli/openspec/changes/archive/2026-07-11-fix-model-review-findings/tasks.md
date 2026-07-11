# Tasks — fix-model-review-findings

## 1. Swappable sandbox emitters (finding 2 — design D1/D2/D4)

- [x] 1.1 Add `createSwappableSandboxEmitters(initialName: ProvModelId)` to
      `modules/harness/prov_bridge.ts`: a holder exposing a STABLE `artifactRegistry`
      (forwarding `register` AND `sync` to the current inner `createBusArtifactRegistry(name)`),
      a STABLE `emitProvenance` function (forwarding to the current inner
      `createRunProvenanceEmitter(name)`), and `swap(name)` rebuilding both inners with the new
      name. Unit tests in `prov_bridge.test.ts`: pre-swap events carry the old name, post-swap
      the new, and the outer object identities never change across a swap.
- [x] 1.2 Thread the holder through composition: `RunEngineComposition` carries the stable
      emitter fields; `buildSandboxStepDeps`/`buildExecuteAnalysisDeps` inject them instead of
      constructing emitters inline; `runtime.ts` builds ONE holder from
      `${connection.provider}/${sandboxModel}` and realizes `swapSandboxEmitters` as
      `holder.swap(name)`. DELETE `capturedExecuteAnalysisDeps`, the `buildExecuteAnalysis`
      capture wrapper, and both `as`-casts on `readonly` deps fields. Update the affected
      composition comments to describe the injection contract (why: consumer read-discipline
      independence), never the diff.
- [x] 1.3 Snapshot-safety regression tests through the REAL bundles (`run_deps.test.ts`):
      build `buildExecuteAnalysisDeps` over a composition with real swappable emitters, capture
      `deps.emitProvenance` into a local const, `swap`, emit `step_completed` through the
      captured reference, assert the bus event's `model` is the NEW `{provider}/{model}`; mirror
      for `artifactRegistry` via a captured reference and a `register` producing
      `prov.command_executed`.
- [x] 1.4 Re-point `agent_switch.test.ts`'s `swapSandboxEmitters` fake to exercise the real
      holder where it cheaply can (or assert the wiring type still matches), keeping the
      controller-timing tests intact.

## 2. Direct-anthropic baseURL convention (finding 1 — design D3)

- [x] 2.1 `modules/harness/model_listing.ts`: anthropic branch targets `{baseURL}/models`
      (headers unchanged); rewrite the branch comment to state the positive convention (the
      configured baseURL is the `/v1`-terminated root; the same value serves
      `POST {baseURL}/messages` and `GET {baseURL}/models`). Update
      `model_listing.test.ts` to pin the new URL (e.g. baseURL `https://api.anthropic.com/v1` →
      `https://api.anthropic.com/v1/models`).
- [x] 2.2 `modules/infra/setup.ts` `promptDirectConnection`: endpoint prompt names the
      convention — anthropic example `https://api.anthropic.com/v1` beside the existing OpenAI
      placeholder — so users author the form both paths consume.

## 3. Cosmetic findings (3 + 4)

- [x] 3.1 `types/prov.ts` `ProvModelId` doc: remove the deleted family-derivation/`unknown/`
      narrative; state the provider part is the configured connection slug (open vocabulary),
      recorded verbatim.
- [x] 3.2 `modules/harness/profile_trigger.test.ts`: move the two imports stranded below the
      `afterEach` up with the sibling imports; keep the `afterEach` and its comment in place.
      (Four stranded imports found and moved, not two; the relocated comment's "now feeds"
      changelog phrasing was corrected to the static form while the lines were in the diff.)

## 4. Verification

- [x] 4.1 From `cli/`: `bun run typecheck`, `bun run lint`, `bun test` — all green; confirm no
      `as`-cast on a harness deps field remains in `runtime.ts` (grep) and
      `openspec validate "fix-model-review-findings"` passes.
