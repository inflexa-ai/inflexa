# Unify the analysis workspace under the anchor

## Why

Every real artifact a run produces lands in a harness session tree at `~/.local/share/inflexa/sessions/<analysisId>/…` — keyed by UUID, under an XDG data dir, undiscoverable from the UI — while `inflexa open` and every user-facing surface point at `.inflexa/analyses/<slug>/`, which only ever receives provenance exports (issue inf-cli#54). The `write-boundary` spec already declares the output directory "the sole writable root"; this change makes that declaration true: one tree, beside the user's data, containing everything the analysis touches.

## What Changes

- **One workspace per analysis**: `<anchorPath>/.inflexa/analyses/<slug>/` becomes the single location for staged inputs (`data/inputs/…`), run artifacts (`runs/<runId>/<stepId>/…`), reports/previews, and provenance exports. Derived live from anchor path + slug — never persisted.
- **BREAKING — the XDG session tree dies**: `env.sessionsDir`, `src/modules/staging/paths.ts` (`sessionTreeRoot`/`sessionTreeDataDir`), and the "single global session-tree base" requirement are deleted. The CLI realizes the harness's new `resolveWorkspaceRoot` seam (harness change `add-workspace-root-resolver`) as an anchor+slug lookup.
- **BREAKING — the output fallback dies**: `env.outputFallbackDir` and `resolveOutputDir`'s XDG-fallback case are deleted. A non-writable or unresolvable anchor is an actionable error at creation and at launch — never a silent redirect.
- **BREAKING — the output override dies**: `inflexa new --output`, `CreateAnalysisOpts.outputOverride`, and the `analyses.output_directory` column are deleted. The workspace location is a rule, not a setting.
- **Rename moves the workspace**: `renameAnalysis` regenerates the slug, so it now also moves `analyses/<old-slug>/` → `analyses/<new-slug>/`, guarded by the per-analysis instance lock (no move during an active run; mid-run anchor moves remain unsupported).
- No `.gitignore` is written (deliberately deferred until user feedback). No backwards compatibility or migration: the app is unshipped.

## Capabilities

### New Capabilities

_None — the change re-scopes existing capabilities._

### Modified Capabilities

- `path-resolution`: `resolveOutputDir` collapses to the single anchor-derived rule and errors on non-writable/unresolvable anchors; the `env.outputFallbackDir` requirement is removed.
- `analysis-service`: creation requires a writable anchor (no override, no fallback persistence); rename moves the workspace directory under the lock.
- `write-boundary`: `computeRoots` errors instead of falling back; the writable root is the anchor-derived workspace.
- `harness-runtime`: the "Single global session-tree base" requirement is removed, replaced by the CLI realization of the harness `resolveWorkspaceRoot` seam.
- `input-staging`: staging targets `{workspaceRoot}/data`; the `.inflexa` noise-dir exclusion becomes load-bearing (it prevents a workspace from staging itself when the anchor folder is an input).
- `analysis-run-launch`: the launch sequence stages into the analysis workspace; the no-inputs and prerequisite gates are unchanged.
- `cli-core`: `inflexa new` loses `--output`; `inflexa open` reveals the workspace that now actually contains results.
- `data-model-storage`: the `analyses.output_directory` column is removed; the `UNIQUE (anchor_id, slug)` rationale now protects the real artifact tree.
- `data-model-types`: the `Analysis` type loses `outputDirectory`.

## Impact

- **Code**: `src/lib/env.ts` (delete `sessionsDir`, `outputFallbackDir` + envDoc entries), `src/modules/analysis/output.ts` (single-rule resolution), `src/modules/analysis/analysis.ts` (creation precondition, no override), `src/modules/analysis/boundary.ts`, `src/modules/analysis/open.ts`, `src/modules/staging/` (target dir; delete `paths.ts`), `src/modules/harness/runtime.ts` (wire `resolveWorkspaceRoot` into every dep bundle), `src/modules/harness/{run,profile,profile_trigger}.ts` (staging targets), `src/tui/commands.tsx` (rename command moves the dir), `src/db/` (drop the column from migration/queries/mutations), `src/cli/index.ts` (`--output` removal).
- **Dependency**: consumes the harness change `add-workspace-root-resolver` (`@inflexa-ai/harness` via `file:../harness`); harness lands first.
- **Docs/help**: `inflexa open` help text and `--help` path listings change; `data-profile-launch` and `tui-harness-chat` specs contain terminology-only "session tree" references that stay semantically valid (the staging-race and no-litter requirements are location-independent).
- **Out of scope**: SQLite/Postgres-resident data, `~/.config/inflexa/*`, logs/locks/models/proxy/compose (Roots 3–5 of the write-map stay as-is).
