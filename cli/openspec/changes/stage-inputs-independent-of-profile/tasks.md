## 1. Make the staged tree a faithful record

- [x] 1.1 In `stageFile` (`src/modules/staging/staging.ts`), stamp the source's `mtime`/`atime` onto the destination after the `copyFileSync` fallback succeeds. Apply it ONLY in the copy branch — a hardlink shares the source inode, so stamping there rewrites the user's own input file and manufactures permanent phantom drift in `enumerateInputSignatures`. Comment the constraint at the call site.
- [x] 1.2 Thread the source `stat` that `materializeStagedFile` already takes into `stageFile`, or stat once before staging, so the stamp does not add a second syscall per file.
- [x] 1.3 Tests: a hardlinked staged file matches its source's size and mtime; a copied staged file matches too; staging by hardlink leaves the source's mtime untouched and a following `enumerateInputSignatures` reports no drift.

## 2. The already-materialized predicate

- [x] 2.1 Add `isInputSetMaterialized(analysisId, targetDir)` to `src/modules/staging/staging.ts`, built on the shared `walkInputFiles` so it cannot diverge from what staging would produce. For each expected file compare the source's size and mtime against a `stat` of `{targetDir}/{relativePath}`.
- [x] 2.2 Detect extra files: walk `{targetDir}/inputs/local` with the same no-ignore set `reconcileStagedTree` uses and report not-materialized when a staged file no current input produces is present.
- [x] 2.3 Make every uncertain case read as not-materialized — missing file, size or mtime mismatch, unreadable path, absent tree. Returns `Result`; a false "already materialized" must be unrepresentable.
- [x] 2.4 Tests: unchanged set true; in-place byte edit false; newly registered input false; removed input whose staged file lingers false; hand-deleted staged file false, and a following `stageInputs` restores it.

## 3. Decouple materialization from the profile decision

- [x] 3.1 Split `stageAndSeed` (`src/modules/harness/profile_trigger.ts`) into a materialize step and a seed step, so the ladder can stage without committing to a trigger. Keep both inside the serialized drive — do not add a second entry point to the tree.
- [x] 3.2 In `ensureProfileAtParity`, move materialization above the profile-status gates for the non-empty-input branch: skip it only for `running` (a live sandbox is reading the tree) and for `completed`-at-parity (its set is materialized by construction). Gate the call on `isInputSetMaterialized` so an unchanged set is not re-hashed.
- [x] 3.3 On a staging failure, return the `failed` outcome with the staging reason and do not reach the profile decision — no seed, no trigger.
- [x] 3.4 Remove the `failed` special case from the drift rule: when the row is `failed` and the set is not materialized (i.e. it drifted), claim `failed → running` via `tryRetryDataProfile` then `runDataProfile`, the same recovery `forceReprofile` performs. When the set is unchanged, keep returning `skipped_failed`.
- [x] 3.5 Add `staged: boolean` to `ProfileParityOutcome` and populate it on every variant, defined as "the check finished with the current input set materialized" — true when this check staged it, found it already materialized, or skipped on a completed-at-parity row; false on a staging failure, an empty input set, or the `running` skip. Keep `kind` describing the profile decision only, so both drivers' exhaustive switches keep compiling untouched.
- [x] 3.6 Update `forceReprofile` to use the same split so the two entry points cannot drift on what materialization means; force still stages unconditionally past its live-run check.
- [x] 3.7 Comment the `already_running` skip with why staging is suppressed there (the reconcile-delete under a live sandbox), cross-referencing the existing `TODO(robustness)` rather than duplicating it.

## 4. Widen the completion edge

- [x] 4.1 In `watchProfileParity` edge 3 (`src/tui/hooks/profile_parity.ts`), fire on `running → failed` as well as `running → completed`, keeping the same-analysis guard that prevents a swap fabricating a false transition.
- [x] 4.2 Update the edge's doc comment: it releases work deferred by the running-skip on either terminal outcome.
- [x] 4.3 Test both transitions drive a re-check, and that an A-running → B-failed swap still fabricates none.

## 5. Notice mapping

- [x] 5.1 In `runParityDrive`, map the newly reachable drift-retry to the re-profiling notice (it is a re-profile). Keep `skipped_failed` silent, and update its comment: the justification is now that the sidebar shows the failure *and* the user's files are on disk.
- [x] 5.2 Verify `runForceDrive`'s exhaustive switch still compiles against the extended outcome and that its "unreachable from `forceReprofile`" comment is still accurate after 3.6.

## 6. Revise the pinned tests

- [x] 6.1 Rewrite `profile_trigger.test.ts:261` (`"a failed row is skipped_failed — never staged, seeded, or triggered"`): a failed row whose input set is already materialized returns `skipped_failed` and stages nothing — `{stage: false, seed: false, trigger: false}` — while the outcome still reports the set as materialized (`staged: true`, per the outcome definition in the tui-harness-chat delta). "Unchanged" and "already materialized" are the same condition here, since a failed row records no signatures of its own.
- [x] 6.2 Add the drift case: a failed row whose set is not materialized stages, retry-claims, and runs.
- [x] 6.3 Add the cheap-path case: a `completed`-at-parity row neither stages nor hashes.
- [x] 6.4 Add the staging-failure case: the outcome is `failed` with the staging reason, and seed/trigger never ran.
- [x] 6.5 Verify the `already_running` case still asserts `stage: false`.

## 7. Verify

- [x] 7.1 `bun run typecheck` and `bun run lint` clean.
- [x] 7.2 `bun test` green across the touched suites (`profile_trigger`, `profile_parity`, `staging`).
- [x] 7.3 Reproduce issue #258 end to end: force a profile failure, register a new input mid-chat, confirm the file appears under `data/inputs/local/`, that `list_files` sees it, and that the profile re-runs on the drift. Verified against the real stack (real SQLite, real filesystem, real Postgres ledger; only the DBOS dispatch stubbed, which needs a booted runtime): the new input lands at `data/inputs/local/second.csv` and the drift claims `failed → running`. Mutation-checked — reverting the ladder to the pre-fix early return makes the repro fail. `list_files` reads that same workspace tree, so file-on-disk is the substantive claim; driving an interactive opentui session was not attempted.
- [x] 7.4 Run `bun run format:file` on every touched file under `src/`.
- [x] 7.5 `openspec validate stage-inputs-independent-of-profile` passes.
