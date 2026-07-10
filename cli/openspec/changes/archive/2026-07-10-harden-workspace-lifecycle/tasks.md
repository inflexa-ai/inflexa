# Tasks — harden-workspace-lifecycle

_Depends on the harness change `harden-workspace-root-seam` (harness/openspec/changes/): the memoization allowance and the injectivity-across-deletion duty are stated there._

## 1. A freed slug never inherits a tree

- [x] 1.1 `src/lib/fs.ts`: add `rmResult` (recursive, force; an absent path is a success)
- [x] 1.2 `src/modules/analysis/output.ts`: add `archivedOutputSubdir(slug)` → `.inflexa/analyses_archived/<slug>`
- [x] 1.3 `src/modules/analysis/output.ts`: add `disposeWorkspace(analysis, "archive" | "delete")` → `WorkspaceDisposal`; archive suffixes `-2`, `-3`, … on a taken destination; a missing tree or unlocatable anchor is `absent`
- [x] 1.4 `src/tui/commands.tsx`: `analysis.delete` gains a second dialog (`DeleteAnalysisFilesDialog`) choosing keep-vs-delete, defaulting to keep
- [x] 1.5 `src/tui/commands.tsx`: `deleteAnalysisWith` disposes BEFORE deleting the row; a failed disposal aborts the delete and says nothing was lost
- [x] 1.6 Tests: archive moves + preserves; delete removes; archive collision suffixes; absent cases; delete→recreate resolves onto a clean tree

## 2. An analysis does not collide with its own slug

- [x] 2.1 `src/modules/analysis/analysis.ts`: `uniqueSlugForAnchor(anchorId, name, { excludeAnalysisId? })`
- [x] 2.2 `renameAnalysisAndMoveWorkspace` passes `excludeAnalysisId`, skips the move when the slug is unchanged, and invalidates the root memo
- [x] 2.3 `renameAnalysisAndMoveWorkspace` reports an unresolvable anchor as `moveError` instead of folding it into "no tree"
- [x] 2.4 Tests: same-name rename is a disk no-op; identically-slugifying rename keeps the slug; a sibling's slug still forces a suffix

## 3. No lifecycle move under a live run

- [x] 3.1 `src/tui/hooks/profile_parity.ts`: add `profileWorkInFlight()` (depth counter over the serialized queue)
- [x] 3.2 `src/tui/hooks/sidebar_live.ts`: export `RUN_STATUS_TERMINAL`
- [x] 3.3 `src/tui/commands.tsx`: add `workspaceBusyReason(analysisId)` — chat turn, profile queue, non-terminal run row; refuse on an unreadable ledger
- [x] 3.4 Gate `analysis.rename` and `analysis.delete` on it
- [x] 3.5 `src/modules/analysis/analysis.ts`: the rename doc states the caller's quiescence duty and drops the false instance-lock claim

## 4. The resolver leaves the read path alone

- [x] 4.1 `src/modules/anchor/anchor.ts`: `resolveAnchor(anchorId, { touch?: boolean })`, default `true`
- [x] 4.2 `src/modules/analysis/output.ts`: `resolveOutputDir` resolves with `touch: false`
- [x] 4.3 `src/modules/analysis/output.ts`: memoize `workspaceRootForAnalysisId` (successes only, process-local, 5s TTL); add `invalidateWorkspaceRoot(analysisId?)`
- [x] 4.4 Invalidate from `renameAnalysisAndMoveWorkspace` and `disposeWorkspace`
- [x] 4.5 Tests: memo hit; invalidation forces re-derivation; failures are not memoized

## 5. Actionable errors reach the user

- [x] 5.1 `src/tui/commands.tsx`: `analysis.open-output` prints a `workspace_unavailable` message verbatim

## 6. Gates

- [x] 6.1 `bun run typecheck`, `bun run lint`, `bun test` all green
- [x] 6.2 `bun run format:file` on every touched file under `src/`
