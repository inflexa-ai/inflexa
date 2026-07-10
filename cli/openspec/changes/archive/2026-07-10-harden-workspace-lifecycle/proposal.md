# Harden the analysis workspace lifecycle

## Why

`unify-analysis-workspace` promoted the slug from a label into a filesystem key: an analysis's inputs, run artifacts, reports, previews, and provenance exports now all live at `<anchor>/.inflexa/analyses/<slug>/`. Three consequences of that promotion were not handled.

- **A deleted analysis leaves its tree behind, and the slug is immediately reusable.** `deleteAnalysis` is a bare `DELETE FROM analyses`, and `uniqueSlugForAnchor` only considers live rows. Delete "Trial" and create "Trial" again in the same folder: the new analysis gets slug `trial`, resolves to the same workspace root, and `inflexa open` reveals its predecessor's `runs/`, `previews/`, and signed provenance exports. Before this workspace was slug-keyed the harness tree was keyed by UUID and reuse was impossible. This violates the harness resolver's own stated contract — two resources must never resolve to the same exclusively-owned root.
- **An analysis collides with its own slug on rename.** `uniqueSlugForAnchor` counts the analysis being renamed among the taken slugs, so renaming "My Analysis" to "My Analysis" (or to any name that slugifies identically) yields `my-analysis-2` and physically moves the directory holding the user's run artifacts.
- **Nothing prevents a rename during an active run.** `analysis.ts` claimed mid-run renames were "excluded structurally: the only rename surface lives in the TUI process that holds the analysis's per-analysis instance lock". The lock excludes other *processes*; the TUI process is the one running the workflows. `RenameAnalysisDialog` had no busy guard, and `execute_plan` returns before its durable run does. The harness spec assigns exactly this duty to the embedder.

Two smaller faults: the palette's "Open output folder" printed `Failed to open: workspace_unavailable`, discarding the actionable message `resolveOutputDir` builds; and `renameAnalysisAndMoveWorkspace` folded a `DbError` from anchor resolution into "there was no tree", reporting plain success.

Separately, the workspace-root resolver is now on the harness's hot path — the harness calls it once per `read_file`/`grep`/`stat` the agent issues — and each call cost two SQLite reads, a marker file read, an `access(2)`, and a **SQLite write** (`touchAnchor`'s sighting heartbeat).

## What Changes

- **Deleting an analysis retires its workspace, and the user chooses how.** A second confirmation step offers "Keep the files" (default — move the tree to `.inflexa/analyses_archived/<slug>/`, suffixed on collision) or "Delete the files permanently". `disposeWorkspace(analysis, mode)` runs *before* the row delete: the filesystem move is what realistically fails, and failing it first changes nothing at all. Either way the tree leaves `analyses/`, so a reused slug resolves onto a clean directory.
- **`uniqueSlugForAnchor` takes `excludeAnalysisId`.** A rename no longer collides with its own slug; a same-slug rename updates the row's name and moves nothing.
- **Rename and delete are gated on workspace quiescence.** A new predicate refuses both while a chat turn is streaming, a data profile is queued/running, or a non-terminal run row exists for the analysis — and refuses when the run ledger cannot be read, rather than guessing.
- **The resolver stops writing on the read path.** `resolveAnchor` gains `touch: false`; `resolveOutputDir` uses it. `workspaceRootForAnalysisId` memoizes successful resolutions (process-local, TTL-bounded, invalidated on rename and disposal) so an agent's file reads no longer each pay a database round-trip and an anchor-heartbeat write.
- `openOutputDir`'s `workspace_unavailable` message reaches the user; `renameAnalysisAndMoveWorkspace` reports an unresolvable anchor as `moveError` instead of silence.

## Capabilities

### New Capabilities

_None — the change hardens capabilities `unify-analysis-workspace` introduced._

### Modified Capabilities

- `analysis-service`: `uniqueSlugForAnchor` excludes the renamed analysis; the rename requirement drops its false instance-lock claim and requires a caller-side quiescence gate; a new requirement covers workspace disposal on delete.
- `path-resolution`: `resolveOutputDir` resolves its anchor without a sighting heartbeat; `workspaceRootForAnalysisId` may memoize, with stated invalidation duties; `archivedOutputSubdir` names the retirement location.
- `harness-runtime`: the resolver realization is memoized and its injectivity is stated to hold across deletion, not merely among live rows.
- `cli-core`: `inflexa open`'s TUI counterpart prints the actionable message.

## Impact

- **Code**: `src/modules/analysis/output.ts` (memo, `archivedOutputSubdir`, `disposeWorkspace`), `src/modules/analysis/analysis.ts` (slug exclusion, honest `RenameOutcome`), `src/modules/anchor/anchor.ts` (`touch` option), `src/lib/fs.ts` (`rmResult`), `src/tui/commands.tsx` (quiescence gate, two-step delete, open message), `src/tui/hooks/profile_parity.ts` (`profileWorkInFlight`), `src/tui/hooks/sidebar_live.ts` (export `RUN_STATUS_TERMINAL`).
- **Dependency**: consumes the harness change `harden-workspace-root-seam` (memoization allowance + injectivity-across-deletion are stated there).
- **User-visible**: deleting an analysis now asks a second question. Artifacts of deleted analyses accumulate under `.inflexa/analyses_archived/` until the user removes them — deliberate; a run's outputs are the user's work, and an archive is recoverable where an `rm -rf` is not.
- **Out of scope**: `inflexa prune`'s `deleteAnalysesForAnchor` path (the anchor folder is gone, so its trees went with it — `disposeWorkspace` already reports `absent` for that case); a CLI `inflexa delete` command (none exists; deletion is TUI-only).
