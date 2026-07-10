# Tasks — unify-analysis-workspace

_Depends on the harness change `add-workspace-root-resolver` (harness/openspec/changes/) landing first — the dep types this change wires against come from `@inflexa-ai/harness`._

## 1. Workspace resolution (the one rule)

- [x] 1.1 `src/modules/analysis/output.ts`: collapse `resolveOutputDir` to the single anchor-derived rule (`join(anchorPath, ".inflexa", "analyses", slug)`), erroring with an actionable message on unresolvable/non-writable anchors; `ensureOutputDir` propagates the err; delete `defaultOutputSubdir`'s fallback branch
- [x] 1.2 `src/lib/env.ts`: delete `sessionsDir` and `outputFallbackDir` (+ their `envDoc` entries); confirm `--help` renders without them
- [x] 1.3 Delete `src/modules/staging/paths.ts` (`sessionTreeRoot`/`sessionTreeDataDir`); callers derive `{workspaceRoot}/data` from the resolution rule

## 2. Data model — the override dies

- [x] 2.1 `src/db/primary_migrations.ts`: drop `output_directory` from the `analyses` baseline (provenance columns now follow `slug`)
- [x] 2.2 `src/db/primary_query.ts` / `primary_mutation.ts`: remove the column from `COLS`, row types, `fromRow`, INSERT/UPDATE lists and bound params
- [x] 2.3 `src/types/analysis.ts`: remove `outputDirectory` from the `Analysis` type
- [x] 2.4 `src/modules/analysis/analysis.ts`: remove `CreateAnalysisOpts.outputOverride` and the fallback-persist branch; add the writable-anchor creation precondition (fail before any insert)
- [x] 2.5 `src/cli/index.ts` + `src/tui/app.launch.tsx`: remove `--output` from `inflexa new`; print the workspace root

## 3. Harness wiring

- [x] 3.1 `src/modules/harness/runtime.ts`: implement the `resolveWorkspaceRoot` realization (analysis row → slug + anchor live path, from the DB) and wire it into every dep bundle that carried `sessionsBasePath` (sandbox client, workspace filesystem, composition, data-profile, conversation deps)
- [x] 3.2 Ensure resolution failures inside workflows surface per the harness contract (throw across DBOS steps; err→throw at the realization boundary)
- [x] 3.3 `src/modules/harness/{run,profile,profile_trigger}.ts`: staging targets become `{workspaceRoot}/data`; add the workspace-writability pre-flight gate to launch sequencing (before boot, beside the existing prerequisite gates)

## 4. Rename moves the workspace

- [x] 4.1 `src/tui/commands.tsx` rename action: acquire the per-analysis instance lock → move `analyses/<old-slug>/` → `analyses/<new-slug>/` → `renameAnalysis` row update; refuse on lock conflict with the standard message; a missing source dir does not fail the rename
- [x] 4.2 Lift the move into a library-pure function beside the analysis module if the palette action grows beyond a thin adapter (single-caller rule applies — only if a second caller appears)

## 5. Boundary and open

- [x] 5.1 `src/modules/analysis/boundary.ts`: `computeRoots` errors when the workspace root cannot be resolved (no fallback substitution)
- [x] 5.2 `src/modules/analysis/open.ts` + palette "open output folder": unchanged flow now reveals the real tree; update `inflexa open` help text ("the analysis workspace: inputs, run artifacts, reports, provenance")

## 6. Verification, tests, docs

- [x] 6.1 Update tests: `output.ts` resolution (error cases replace fallback cases), `analysis.ts` creation precondition + no-override, staging targets, `db/` column removal, rename-move (idle, locked, missing-dir), boundary error case
- [x] 6.2 E2E: create → add inputs → profile → run → `inflexa open` path contains `runs/<runId>/…` artifacts (the inf-cli#54 repro, now green); non-writable dir refuses creation with the actionable message
- [x] 6.3 Sweep residual `session tree`/`sessionsDir` references in code comments, `cli/CLAUDE.md`, `cli/CONTEXT.md`; note the terminology-only mentions in `data-profile-launch`/`tui-harness-chat` specs stay valid
- [x] 6.4 `bun run typecheck`, `bun test`, `bun run lint`; `bun run format:file` on touched sources
