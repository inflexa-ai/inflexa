# Tasks — remove-custom-provenance-persistence

## 1. Noop registry replaces the filesystem registry

- [x] 1.1 Add `src/execution/noop-artifact-registry.ts`: `createNoopArtifactRegistry(): ArtifactRegistry` — `register` resolves `{ registered: [], failed: [], failedCount: 0 }`, `sync` resolves without effect; header comment states why a no-op is the honest local default (harness writes `cortex_artifacts` itself around the seam; nothing external to register locally)
- [x] 1.2 Add `src/execution/noop-artifact-registry.test.ts` asserting the returned result shape and that `sync` resolves (state, not interactions)
- [x] 1.3 Delete `src/execution/filesystem-artifact-registry.ts` and `src/execution/filesystem-artifact-registry.test.ts`
- [x] 1.4 Barrel swap in `src/index.ts`: remove `createFilesystemArtifactRegistry` / `FilesystemArtifactRegistryDeps` exports, export `createNoopArtifactRegistry`; keep the `ArtifactRegistry` type family exports unchanged
- [x] 1.5 Update the stale cross-reference in `src/execution/artifact-registry.ts` (interface-file comment naming `FilesystemArtifactRegistry` as the OSS realization) to name the noop realization

## 2. Delete the dead write-snapshot seam

- [x] 2.1 Delete `src/workspace/provenance-collector.ts` (`ProvenanceCollector` interface + `ProvenanceSnapshot`)
- [x] 2.2 `src/tools/workspace/mutator.ts`: drop the `provenance?` dep field, the `recordSnapshot` call + its catch/log wrapper, and the import; keep write/edit behavior and confinement untouched (also removed with it: the `MutatorLogger`/`defaultLogger`/`logger?` machinery and the `runId` dep field — both existed solely for the snapshot block)
- [x] 2.3 `src/agents/sandbox/shared.ts`: drop the workspace-collector import, the `provenance?` build-context field and its doc comment, the destructure, and the conditional spread into mutator deps (the `lineageCollector` threading stays untouched)
- [x] 2.4 Update `src/tools/workspace/write-file.test.ts`, `edit-file.test.ts`, `mutate-surface-e2e.test.ts`: remove mock snapshot collectors and snapshot-recording assertions; keep the write-outcome/confinement assertions
- [x] 2.5 Rewrite the `src/index.ts` comment block that disambiguates the two `ProvenanceCollector`s (only the lineage-collector class remains)

## 3. Stale-comment and reserved-arm hygiene

- [x] 3.1 Fix `processProvenanceFrame` references — `src/provenance/collector.ts:20`, `src/sandbox/ignored-dirs.ts:3,10`, `src/execution/reconcile-manifest.ts:14` — to name the live counterpart (`feedExecFrame` / the manifest walk) in current-state terms (also deleted the dead `isToolNoisePath` export — zero consumers, phantom-doc'd)
- [x] 3.2 Rewrite the `classifyReadPath` prior-run-fallback comment box (`src/provenance/collector.ts:116-157`): keep the real rationale (prior-run reads carry no step metadata, so path extraction is the only source), drop the phantom `StepMetadata.sourceRunIds` / `workspace-profiles.ts:53` references and the stale elimination recipe (a second phantom `StepMetadata` mention in the `InputClassificationContext` doc fixed too)
- [x] 3.3 Document `ProvenanceFrame.deletes` as reserved on `ProvenanceFrameSchema` (`src/sandbox/types.ts`): captured by all four sandbox layers per sandbox-provenance-tracking, zero harness consumers, kept on the wire for a future invalidation mapping

## 4. Harness docs and spec prose

- [x] 4.1 `CLAUDE.md`: replace the three `FilesystemArtifactRegistry`/`createFilesystemArtifactRegistry` mentions (front-door list, composition list, capability-seams list) with the noop realization
- [x] 4.2 `CONTEXT.md`: update the `ArtifactRegistry` seam description (currently "OSS realization: `FilesystemArtifactRegistry` — a real local provenance index")
- [x] 4.3 `openspec/specs/exec-provenance-lineage/spec.md` purpose prose: replace the "OSS build exposes … its `FilesystemArtifactRegistry` realization" sentence with the embedder-bound reality (interface + noop local default; the live realization is the embedder's, e.g. the cli bus adapter); requirements untouched
- [x] 4.4 Sweep finding (scope extension): `README.md` barrel import example listed `createFilesystemArtifactRegistry` — swapped to `createNoopArtifactRegistry`
- [x] 4.5 Sweep finding (scope extension): `explicit-input-classification` — its purpose prose AND its prior-run-fallback requirement narrate a phantom `sourceRunIds` declaration (declared nowhere in the tree); purpose fixed in place, requirement reworded via a new delta spec in this change to mandate the truthful comment (prior-run reads carry no step metadata; path extraction is the only identity source)

## 5. cli spec drift fixes (spec files only — verify each against cli source first, cite file:line)

- [x] 5.1 `cli/openspec/specs/prov-signing/spec.md` + `prov-chain/spec.md`: remove/rewrite the degrade-to-unsigned flush scenarios — code never persists unsigned (signing failure fails the flush); verify against the cli flush/sign path before editing
- [x] 5.2 `cli/openspec/specs/prov-chain/spec.md` + `data-model-storage/spec.md`: replace the v2/v3 ALTER TABLE migration narrative with the actual single-baseline schema (all four provenance columns incl. `provenance_prev_chain_hash`); verify against the cli schema source
- [x] 5.3 `cli/openspec/specs/prov-verify/spec.md`: list the actual `VerifyResult` variants (docs claim 5; code has 8 — count them in the cli source and enumerate exactly)
- [x] 5.4 `cli/openspec/specs/prov-verify/spec.md`: correct export-without-signature behavior — export fails entirely rather than writing no sidecar; verify against the cli export path
- [x] 5.5 Same-class drift found during 5.1–5.4, same files (scope extension): analyses-table-shape scenario omitted the four provenance columns; `getAnalysisIntegrity` described as 2-field non-nullable when code returns 4-field `AnalysisIntegrity | null` and `updateAnalysisProvenance` requires all values + rotates `prev_chain_hash`; TUI verify-notice scenario enumerated a stale 5-status subset — all corrected against `primary_migrations.ts:29-44`, `primary_query.ts:306-332`, `primary_mutation.ts:319-331`

## 6. Gates

- [x] 6.1 `tsc -p tsconfig.json` clean in `harness/` (run twice: worker + orchestrator independently)
- [x] 6.2 `bun test` green in `harness/` — 725 pass / 1 skip (pre-existing API-key gate) / 0 fail (run twice: worker + orchestrator independently)
- [x] 6.3 Repo-wide grep proves zero remaining references: `FilesystemArtifactRegistry`, `provenance-index`, `recordSnapshot`, `ProvenanceSnapshot`, `processProvenanceFrame`, `sourceRunIds` (docs/harness_integration* research archives exempt) — the only hits are the three main-spec requirement texts this change's delta specs rewrite at archive/sync (`artifact-manifest:170`, `harness-durable-runtime:117`, `explicit-input-classification:136`), which is the expected pre-archive state
