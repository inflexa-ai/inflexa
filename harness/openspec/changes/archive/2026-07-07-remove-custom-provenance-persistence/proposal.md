# Remove Custom Provenance Persistence

## Why

The harness's custom provenance persistence — `FilesystemArtifactRegistry` writing
`provenance-index.json` — was built for an embedder that never arrived and has zero
production instantiations (own file + test + barrel export only; nothing ever reads the
file back). Since `bridge-harness-provenance` (+ `deepen-run-provenance`,
`record-command-lineage`) landed in the cli, the live `ArtifactRegistry` realization is
the cli's bus adapter feeding the signed tsprov ledger — the filesystem registry has no
hypothetical consumer left, and its own header naming "the CLI" as its intended consumer
now actively misleads readers toward a dead code path. The same landing killed the last
excuse for two other pieces of debt: the workspace write-snapshot seam
(`workspace/provenance-collector.ts` — a `recordSnapshot` interface with zero production
implementations, whose governing spec requirement falsely claims registration consumes
the snapshots) and a set of stale comments referencing code that no longer exists
(`processProvenanceFrame`, `StepMetadata.sourceRunIds`). This is change E of the
harness-integration change graph (`docs/harness_integration-new/06-change-graph.md`),
deliberately sequenced last so a fallback stayed visible until the bridge was proven
live — it has been, three changes deep.

## What Changes

- **Delete `FilesystemArtifactRegistry`** (`src/execution/filesystem-artifact-registry.ts`
  + test) and the `provenance-index.json` format with it. **BREAKING** for the package
  barrel: the `createFilesystemArtifactRegistry` / `FilesystemArtifactRegistryDeps`
  exports are removed.
- **Add `createNoopArtifactRegistry`** as the seam's OSS realization (registers nothing,
  reports zero failures, `sync` no-op). The five-seams pattern is a spec requirement
  ("Core SHALL … ship trivial local realizations"), and the harness writes the
  `cortex_artifacts` ledger itself around the seam — so "no external provenance ledger
  attached" is the honest local default, matching `createNoopRunCharge` /
  `createNoopBillingResolver` in spirit.
- **Delete the dead write-snapshot seam**: `src/workspace/provenance-collector.ts`
  (`ProvenanceCollector`/`ProvenanceSnapshot`), the optional `provenance` dep and
  `recordSnapshot` call in the workspace mutator, its threading through the sandbox-agent
  build context, and the mock implementations in the mutate-surface tests. The
  spec requirement mandating snapshot recording is removed — its claim that
  "registration consumes these snapshots as lineage" has been false since the seam died;
  real lineage hashes come from `reconcileManifestWithDisk`'s disk attestation.
- **Fix stale-comment debt**: `processProvenanceFrame` references
  (`provenance/collector.ts`, `sandbox/ignored-dirs.ts`, `execution/reconcile-manifest.ts`)
  and the `classifyReadPath` prior-run-fallback comment block citing the nonexistent
  `StepMetadata.sourceRunIds` / `workspace-profiles.ts` field — rewritten to state the
  actual current rationale.
- **Document `ProvenanceFrame.deletes` as reserved** (decision: keep on the wire). All 4
  sandbox capture layers report deletes per `sandbox-provenance-tracking`, but the
  harness has zero consumers; removing it would touch all four hook layers + Go for no
  functional gain. A schema comment states the reserved status.
- **Cross-tree spec hygiene (rides along, no cli code changes)**: fix the four cli prov
  spec drifts inventoried in `docs/harness_integration-new/01-provenance-cli-target.md` §6
  — degrade-to-unsigned flush described but never implemented (and contrary to the
  signing policy), phantom v2/v3 ALTER TABLE migrations vs the actual single-baseline
  schema, 5 documented `VerifyResult` variants vs 8 in code, and
  export-without-signature described as sidecar-less when the code fails the export.
  Plus doc-prose drift in this tree: `exec-provenance-lineage`'s purpose naming the
  filesystem realization, and the `FilesystemArtifactRegistry` mentions in harness
  `CLAUDE.md` / `CONTEXT.md`.

## Capabilities

### New Capabilities

_None — the `ArtifactRegistry` seam already exists; only its local realization changes._

### Modified Capabilities

- `harness-durable-runtime`: the "Capability seams isolate core from managed
  realizations" requirement names the OSS `ArtifactRegistry` realization — it becomes
  `createNoopArtifactRegistry` (no local provenance index; external registration is a
  genuine no-op locally).
- `artifact-manifest`: the "Integrity stages fail-fast; enrichment stages degrade"
  requirement cites "The OSS `FilesystemArtifactRegistry` returns `externalFailed: 0`
  and never trips this" — the citation moves to the noop registry (same
  never-trips property).
- `harness-workspace-tools`: the "Mutate surface records SHA-256 content snapshots for
  provenance" requirement is removed with the dead seam.
- `explicit-input-classification`: the "Prior-run classification is the one documented
  path-extraction fallback" requirement mandates an in-code comment narrating the
  `sourceRunIds` gap — but `sourceRunIds` is declared nowhere (the premise is itself
  drift). The requirement is reworded to mandate the truthful rationale: prior-run
  reads carry no step metadata, so path extraction is the only identity source.

## Impact

- **Harness code**: `src/execution/filesystem-artifact-registry.ts` (+test) deleted;
  `src/execution/noop-artifact-registry.ts` (+test) added; `src/index.ts` barrel
  (registry exports + the seam-comment referencing the workspace collector);
  `src/workspace/provenance-collector.ts` deleted; `src/tools/workspace/mutator.ts`
  (drop optional dep + call site); `src/agents/sandbox/shared.ts` (drop import, dep
  field, spread); `src/tools/workspace/{write-file,edit-file,mutate-surface-e2e}.test.ts`
  (drop mock collectors); comment-only edits in `src/provenance/collector.ts`,
  `src/sandbox/ignored-dirs.ts`, `src/execution/reconcile-manifest.ts`,
  `src/sandbox/types.ts`.
- **Harness docs**: `CLAUDE.md` (front-door list, composition list, seam list),
  `CONTEXT.md` (seam description), `README.md` (barrel import example),
  `openspec/specs/exec-provenance-lineage/spec.md` and
  `openspec/specs/explicit-input-classification/spec.md` purpose prose.
- **cli**: spec files only — `openspec/specs/{prov-chain,prov-signing,prov-verify,data-model-storage}/spec.md`
  corrected to match long-shipped code. No cli source changes; the cli imports nothing
  this change deletes (grep-verified).
- **Consumers**: any embedder importing `createFilesystemArtifactRegistry` must move to
  `createNoopArtifactRegistry` or its own realization. The only known embedder (the cli)
  uses its own bus adapter and is unaffected.
