# Prior Work: the `feat/provenance` Stash and the Leftover `src/` Tree

Verified 2026-07-02 against the post-merge tree. Corrects the old
`docs/harness_integration/03-prior-work-inventory.md` in three places (see §5).

## 1. Timeline (established from git)

| When | What |
|---|---|
| 06-29 15:12 | `stash@{0}` created on `feat/provenance` (base = dangling WIP commit `e007b83` "A" — orphaned, reachable only via the stash) |
| 06-29 21:09 | `feat/provenance` tip `78ed278` — the branch was re-worked AFTER the stash was cut |
| 06-29 22:51 | `src/modules/staging/{staging.ts,staging.test.ts}` written — untracked, never committed on ANY branch |
| 06-30 16:17 | `src/tui/components/fixed_list.tsx` draft — untracked |
| 07-02 15:09 | `main` tip `0712e31` — current monorepo structure (`cli/` + `harness/`) |

Root `src/` today contains exactly 3 files (the two staging files + the fixed_list
draft) — stragglers from the pre-monorepo layout, not a full old tree.

## 2. The stash — design-complete blueprint, but PORT, don't POP

Contents (`git stash show --stat`): 7 files, +309/−12 — all old-structure root `src/…`
paths. Tracked modifications only (no third untracked-files parent).

What it adds (written when the harness was still called **cortex-core**):
- 4 bus events: `prov.run_started`, `prov.run_completed`, `prov.step_completed`,
  `prov.file_written` (each with `analysisId` + `ProvActor`).
- 4 domain types: `ProvRunRef {runId, goal?}`, `ProvRunOutcome {runId, status(3-of-6),
  durationMs?}`, `ProvStepRef {runId, stepId, command?, exitCode?, durationMs?}`,
  `ProvFileRef {path, hash, size, producer: "command"|"file_tool"}`.
- 4 document builders with deterministic QNames: `inflexa:run-{runId}`,
  `inflexa:step-{runId}-{stepId}`, `inflexa:file-{Bun.hash(path|hash).toString(36)}`.
- 4 recorder cases (exact existing `onEvent` pattern — the current cli switch structure
  is unchanged, so these port almost verbatim), bus `eventFields` telemetry, and a full
  test suite (builders, PROV-JSON round-trip, bus→flush→DB-column end-to-end).
- Path helpers in `output.ts`: `sessionTreeRoot` (= `resolveOutputDir(analysis)/analysis.id`,
  "the base path cortex-core's composition root receives as sessionPath"),
  `dataInputsDir` (= `{root}/data/inputs`), `runStepDir(runId, stepId)`.

### Why `git stash pop` fails (the old checklist's Phase 1 is wrong)

1. **Wrong tree** — patches `src/…`; popping onto `main` would materialize a parallel
   root tree, not touch `cli/src/`. The base commit is dangling.
2. **API drift** — the stash context predates feat/provenance's last 7 commits, which
   DID reach `cli/` via the monorepo restructure:
   `signChainHash` → `signHexDigest` (ResultAsync), `verifyChainHash` →
   `verifyHexDigest`, sync `flushProvenance` → `flushProvenanceAsync`, `loadDocument`
   now returns `Result<_, {type:"prov_corrupt"}>`, `serializeProvenance` returns exact
   stored bytes, `VerifyResult` 5 → 8 variants.
3. Nothing was ever ported: greps for every stash identifier over `cli/src` → zero hits.

### Quirks to fix during the port (feed into 03 §4)

- `appendFileWritten` / `appendRunCompleted` call `startAction(...)` and discard the
  result → orphan `inflexa:action-{uuid}` activities per event; non-deterministic under
  DBOS replay.
- `appendRunCompleted` records `doc.entity(runQName, …)` on a QName declared as an
  *activity* by `appendRunStarted` — same identifier, two record kinds.
- `ProvRunOutcome.status` claims to mirror the harness vocabulary but is a 3-of-6 subset
  (`harness/src/state/schema.ts:46`).
- `ProvFileRef.producer` discriminant verified still matching harness `ProducerSchema`
  literals (`harness/src/provenance/types.ts:15-31`) — this part is grounded.
- Stash `runStepDir(runId, stepId)` is analysis-root-relative; harness
  `runStepDir(resourceId, runId, stepId)` (`workspace/paths.ts:206-211`) prefixes
  `resourceId`. Identical name, different shape — rename the cli one.

## 3. `src/modules/staging/` — directly reusable, relocate as-is

**Verdict: move both files to `cli/src/modules/staging/` essentially unchanged.**
Import-by-import verification against the current cli tree: `mkdirResult`/`statResult`/
`FsError` (`cli/src/lib/fs.ts`), `sha256File` (`cli/src/lib/hash.ts:7` — gains its first
caller), `listAnalysisInputs` (`db/primary_query.ts:278`), `resolveInputPath`
(`modules/analysis/input.ts:48`), test-support `freshDb` + the insert mutations — all
present and tracked in `main`. `Analysis`/`AnalysisInput` shapes match
`cli/src/types/analysis.ts:12-57` exactly.

Behavior (162 lines, neverthrow throughout):
- `stageInputs(analysisId: string, targetDir: string)` → `StagedInput[]`; unresolvable
  inputs skipped ("partial staging is better than total failure"); directories walked
  into per-file entries.
- `stageFile`: hardlink first, copy on cross-filesystem failure — sound because the
  harness mounts the analysis tree read-only (`mount-strategy.ts:76-81`).
- `StagedInput` verified **field-for-field identical** to
  `harness/src/execution/staged-input.ts:22-31` — wire-compatible, no transform.
- Test suite: 6 tests incl. real on-disk anchor-marker fixtures.

Two fixes to make during the relocation (both verified by direct full read):
- `deriveFileId` hashes `anchorId|path/subpath` for directory members, while the cli's
  PROV `inputQName` hashes `anchorId|path` without subpath — the "same key space"
  comment holds only for single-file inputs.
- `walkFiles` (`staging.ts:68-88`) silently DROPS symlinks: its comment claims
  "Symlinks are followed (statSync resolves them)" but the implementation uses
  `readdirSync(..., {withFileTypes: true})` Dirents — a symlink entry answers false to
  both `isDirectory()` and `isFile()`, so it is neither traversed nor staged. Either
  stat-resolve symlink entries or document the exclusion; the current comment lies.

Error-handling precision (the old doc overstated "best-effort"): only *unresolvable*
inputs (orphaned anchors → `resolveInputPath` null) are skipped (`staging.ts:137`); any
actual staging I/O error fails the whole run via early `err(...)` returns
(`staging.ts:143,149,156`).

## 4. `src/tui/components/fixed_list.tsx` — delete

Superseded by the shipped ListCore-based `FixedList`
(`cli/src/tui/components/fixed_list.tsx`). The draft has an inverted-condition crash bug
(`items.get(c)!.push` on the branch where the key is missing) and placeholder JSX.
Zero reuse value.

## 5. Corrections to the old research

1. Old `03-prior-work-inventory.md` / `05-implementation-checklist.md` step "Apply the
   stash: `git stash pop`" — **wrong** (§2: wrong tree, dangling base, API drift).
   Port by hand.
2. Old docs state `stageInputs(analysis, dataDir)` — actual signature is
   `stageInputs(analysisId: string, targetDir: string)`.
3. Old docs understate the test-import drift (`flushProvenance`, `verifyChainHash` no
   longer exist under those names).

Also newly established: `harness/src/index.ts` exports neither `StagedInput` nor the
data-profile trigger (grep-verified) — the embedder barrel must grow, or the cli
deep-imports. And `harness/CLAUDE.md`'s storage-layout claim of `data/inputs/{fileId}/`
contradicts the code (`inputArtifactPath` = `data/{relativePath}` =
`data/inputs/local/{key}`, `data-profile.ts:111-113`) — the code is authoritative; fix
the CLAUDE.md when touching that area.
