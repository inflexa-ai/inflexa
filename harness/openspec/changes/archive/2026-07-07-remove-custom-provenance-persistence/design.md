# Design — remove-custom-provenance-persistence

## Context

Change E of the harness-integration change graph
(`docs/harness_integration-new/06-change-graph.md`). The signed tsprov ledger in the cli
is the only persisted provenance: the cli's bus-adapter `ArtifactRegistry`
(`cli/src/modules/harness/prov_bridge.ts`) has been the live seam realization since
`bridge-harness-provenance`, deepened by `deepen-run-provenance` and
`record-command-lineage`. The harness's own persistence path — `FilesystemArtifactRegistry`
writing `provenance-index.json` — has zero production instantiations (grep-verified: own
file + test + barrel export at `src/index.ts:28-29`; nothing reads the file back). The
verified delete inventory is `docs/harness_integration-new/02-provenance-harness-inventory.md`
§6 and the GOES table in `03-provenance-migration-plan.md` §1.

Constraints:

- The sensor stays untouched: sandbox 4-layer capture, `src/provenance/` (lineage
  collector, `feedExecFrame`), reconcile/attestation, the `ArtifactRegistry` seam
  itself, and the `cortex_artifacts` ledger are all out of scope (03 §1 STAYS table).
- `harness-durable-runtime` requires the seams to ship "trivial local realizations" —
  the seam cannot simply lose its OSS realization.
- The cli imports none of the deleted symbols (grep-verified), so no cli source change.

## Goals / Non-Goals

**Goals:**

- Delete the custom provenance persistence format and its dead sibling seam so the only
  provenance story a reader can find is the real one (bus adapter → signed tsprov doc).
- Restore spec/doc truthfulness on both trees: no requirement or doc paragraph may
  describe behavior the code does not have.
- Keep `assembleCoreRuntime` assemblable by a fresh embedder with zero custom code.

**Non-Goals:**

- No lineage-coverage extension (tool-read/tool-write tracking, data-profile/ephemeral
  collectors) — those are D2-findings follow-ups, separate changes.
- No change to `ArtifactRegistrationInput` (the `collector` field stays required — the
  cli bridge consumes it; reshaping the seam is not this change).
- No removal of the `ProvenanceFrame.deletes` wire arm (decision below).
- No cli source changes.

## Decisions

### D1 — Replace the filesystem registry with `createNoopArtifactRegistry`, not a bare deletion

The five-seams requirement in `harness-durable-runtime` mandates trivial local
realizations, and a fresh embedder must be able to call `assembleCoreRuntime` without
inventing a stub. The noop is contract-honest: the harness writes `cortex_artifacts`
itself around the seam (`artifact-registration.ts`), so "no external provenance ledger
attached" is a genuine local default — `register` returns
`{registered: [], failed: [], failedCount: 0}` (never trips the fail-fast gate, exactly
the property `artifact-manifest` already relies on), `sync` is a no-op. This is the same
shape change F's cli stub proved viable before the bus adapter replaced it.

*Alternative rejected:* delete with no replacement — breaks the spec'd seam pattern,
makes the minimal embedder path "write your own no-op", and turns the `artifact-manifest`
fail-fast requirement's OSS citation into a dangling reference.

### D2 — Delete the workspace write-snapshot seam instead of implementing it

`workspace/provenance-collector.ts` (`recordSnapshot`) has had zero production
implementations ever — the mutate tools' calls are dead branches behind an optional dep
nobody supplies, and the governing requirement's claim that "artifact registration
consumes these snapshots as lineage" has never been true (registration hashes from disk
via `reconcileManifestWithDisk`). If harness-side tool-write lineage is ever wanted, the
right home already exists: the lineage collector's `recordFileToolWrite`
(`src/provenance/collector.ts:252`, itself currently uncalled — wiring it is the
tool-write half of the tool-I/O lineage gap noted in the D2-change findings, out of
scope here). One lineage concept, not two parallel ones.

*Alternative rejected:* implement the seam (feed snapshots into lineage) — duplicates
what `recordFileToolWrite` models, and builds coverage this change's scope excludes.

### D3 — Keep `ProvenanceFrame.deletes` on the wire, documented as reserved

All four sandbox capture layers report deletes per `sandbox-provenance-tracking`
(a spec'd requirement), while the harness has zero consumers (`exec-frame.ts` reads only
`reads`/`writes`). Removing the arm means touching four hook layers + Go + the spec for
no functional gain; a future `wasInvalidatedBy` mapping needs exactly this data. A
schema comment on `ProvenanceFrameSchema` states the reserved status so the asymmetry
reads as deliberate.

### D4 — Requirement changes ride delta specs; pure description drift is edited directly

Four harness capabilities change at requirement level and get deltas
(`harness-durable-runtime`, `artifact-manifest`, `harness-workspace-tools`, and
`explicit-input-classification` — the last found by the apply-time sweep: its prior-run
requirement mandated an in-code comment narrating a `sourceRunIds` declaration that
exists nowhere in the tree). Everything else is prose describing code that already
shipped — the `exec-provenance-lineage` and `explicit-input-classification` purpose
paragraphs, harness `CLAUDE.md`/`CONTEXT.md`/`README.md`, and the cli spec drifts
(`01-provenance-cli-target.md` §6, plus three same-class inaccuracies found in the same
files during verification) — and is corrected in place. The cli edits are
truth-restoration only (the described behaviors — never-degrade-to-unsigned, single
baseline schema, 8 `VerifyResult` variants, export-fails-without-signature — all shipped
long ago); routing them through a cli-tree change would be ceremony around zero code.
Each cli edit must be re-verified against cli source at implementation time (file:line
in hand) rather than trusted from the research docs.

### D5 — Barrel evolution is a straight swap

`createFilesystemArtifactRegistry`/`FilesystemArtifactRegistryDeps` exports are removed
(**BREAKING**), `createNoopArtifactRegistry` is exported in their place. The
`ArtifactRegistry`/`ArtifactRegistrationInput`/`ExternalRegistrationResult` type exports
and the `ProvenanceCollector` (lineage class) export stay. The barrel comment
disambiguating the two `ProvenanceCollector`s (`src/index.ts:31-34`) loses its reason to
exist with the workspace seam gone — it is rewritten to describe only the lineage
collector.

## Risks / Trade-offs

- [Unknown external embedders import the deleted exports] → The package is consumed via
  `file:../harness` by the cli only; the swap is named in `CLAUDE.md` and the breaking
  change is flagged in the proposal. Accepted.
- [Mutate-surface tests were written around mock snapshot collectors] → Drop the
  snapshot assertions with the seam rather than re-pointing them at something else;
  the tests' remaining assertions (write outcomes, confinement) stand on their own.
  Per testing convention, no interaction-assertions are added to compensate.
- [cli spec edits could themselves drift from code] → Implementation tasks require
  reading the cli source first (e.g. count the actual `VerifyResult` variants) and
  citing file:line in the task checklist before editing the spec.
- [Rewriting the `classifyReadPath` fallback comment could lose real rationale] → The
  prior-run path-extraction fallback is real and stays; only the phantom references
  (`StepMetadata.sourceRunIds`, `workspace-profiles.ts:53`) and the stale elimination
  recipe go. The rewritten comment states why path extraction is needed (prior-run
  reads carry no step metadata) in current-state terms.

## Migration Plan

Single PR, no data migration: `provenance-index.json` was only ever written by code with
zero production instantiations, so no real deployment has files to migrate; nothing ever
read them back regardless. Rollback is a straight revert. Gates: `tsc -p tsconfig.json`
clean, `bun test` green in `harness/`; cli untouched at source level, so its gates run
only if its spec-file edits are batched with anything else (they are not expected to be).

## Open Questions

None — the two decisions the research left open for this change (`deletes` arm, spec-fix
placement) are settled in D3/D4.
