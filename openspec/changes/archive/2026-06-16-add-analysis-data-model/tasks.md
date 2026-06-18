## 1. Domain types (`src/types/`)

- [x] 1.1 Add the id aliases `AnchorId`/`AnalysisId`/`ProjectId` over the shared `ID` (uuidv7) alias, plus `IdOrName` and the branded `Str256` (`str256`/`asStr256`) in `src/lib/types.ts`.
- [x] 1.2 Add `Anchor`, `Project`, `Analysis`, `AnalysisInput`, `AnchorMarker` under `src/types/`, grouped by domain, identity → core → FK ordering, optionality as `T | null`, full JSDoc. Leave the existing chat/event types unchanged.

## 2. Schema (`src/db/primary_migrations.ts`)

- [x] 2.1 Single `version: 1` baseline: columnar `anchors`/`projects`/`analyses`, blob-free `analysis_inputs`, `sessions.analysis_id`, declared parent-before-child.
- [x] 2.2 `UNIQUE (anchor_id, slug)` on `analyses`; `ON DELETE CASCADE` from inputs/messages/parts; the seven lookup indexes.

## 3. DB access (`src/db/primary_query.ts`, `primary_mutation.ts`)

- [x] 3.1 Columnar `COLS`/`Row`/`fromRow` per entity (identity → core → FK); re-brand names with `asStr256`.
- [x] 3.2 Anchor reads/writes: `getAnchor`, `listAnchors`, `insertAnchor`, `updateAnchorCachedPath`, `touchAnchor` (last_seen only), `deleteAnchor`.
- [x] 3.3 Analysis reads/writes: `listAnalyses`/`listAnalysesByAnchor`/`listAnalysesByProject` (newest-first), `insertAnalysis`, `updateAnalysis`, `updateAnalysisProject`, `findAnalysesByRef` (id-priority), `listAnalysisInputs`, `insertAnalysisInput`.
- [x] 3.4 Project + session: `createProject` (mints inline, UNIQUE-name), `listProjects`, `findProjectByRef`, `countAnalysesByProject`/`countAnalysesByAnchor`, `createSession({ analysisId })`, `listSessionsByAnalysis`.
- [x] 3.5 Backstop helpers: `deleteAnalysesForAnchor`, `relocateRawInputPrefix`.

## 4. Anchor marker (`src/modules/anchor/marker.ts`)

- [x] 4.1 `markerPath`, `canonicalPath`, `readMarker` (throws on corrupt/wrong version), `writeMarker` (write-once), `isDirWritable` (no probe litter), `findMarkerUpwards`. Filesystem-only, mints no ids.

## 5. Anchor resolve (`src/modules/anchor/anchor.ts`)

- [x] 5.1 `getOrCreateAnchorForCwd` (mint uuidv7 inline; `markerWritten` per writability; self-heal drift).
- [x] 5.2 `resolveAnchor` (3-step lazy reconciliation), `classifyMarkerSighting` (copy/move/ok), `recoverAnchors` (passive, no-litter).

## 6. Path resolution (`src/lib/env.ts`, `src/modules/analysis/{input,output}.ts`)

- [x] 6.1 `env.outputFallbackDir` + `envDoc` entry.
- [x] 6.2 `classifyInputPath` / `resolveInputPath` (anchor-relative vs absolute; non-existent path errors).
- [x] 6.3 `resolveOutputDir` (3-case) / `ensureOutputDir` (idempotent; output-dir only).

## 7. Analysis service (`src/modules/analysis/analysis.ts`)

- [x] 7.1 `createAnalysis` (anchor → unique slug → insert → inputs → output-dir persist), `addInputs` (classify, de-dup, reject dangling).
- [x] 7.2 `listAnalysesForAnchorAt`, `listRecentAnalyses`, `findAnalysis`, `matchAnalysis` (collision reshape). Library-pure, no archive.

## 8. Context resolution (`src/modules/analysis/context.ts`)

- [x] 8.1 `resolveContext` (flag → marker → empty, with copy guard) and `describeContext`. Pure data, no I/O.

## 9. Chat wiring (`src/db/primary_mutation.ts`, `src/tui/launch.tsx`)

- [x] 9.1 `createSession` writes `analysis_id`; `Session` JSON unchanged.
- [x] 9.2 `launchChat` (proxy-ready → resolve session → recoverAnchors → render at anchor path); shared `ensureProxyReadyOrExit`/`renderApp` preamble.

## 10. CLI core (`src/cli/index.ts`, `src/tui/launch.tsx`, `src/modules/analysis/{ls,open,status}.ts`)

- [x] 10.1 Commander default action (`launchDefault`), `new` (`launchNew`), `resume` (`launchResume`).
- [x] 10.2 `ls`, `open`, `status` text actions; clack-based confirm/picker via `lib/cli`.
- [x] 10.3 Copy context surfaced and directed to the backstop (clone/fork deferred — see 12.2).

## 11. Projects (`src/modules/project/project.ts`, `src/modules/analysis/set_project.ts`)

- [x] 11.1 `project new` / `project ls`; `--project` resolved by id or name in `ls`/`new`/context.
- [x] 11.2 `analysis set-project` (resolve project before write; omit to clear; no orphaning). No pass-through wrappers.
- [ ] 11.3 `project archive` — deferred (see design.md → Deferred & dropped; flagged as an accidental omission vs the data model).

## 12. Move backstop (`src/modules/anchor/backstop.ts`)

- [x] 12.1 `inf repair` (by path), `inf relocate` (single `<from> <to>` + `--from/--to` batch, path-addressed), `inf prune` (marker-backed, gone, not re-findable).
- [ ] 12.2 Copy clone/fork resolution (`resolveCopiedFolder`) — deferred (`TODO(extend)`); copies are detected and surfaced, never auto-resolved.

## 13. Write boundary (`src/modules/analysis/boundary.ts`)

- [x] 13.1 `computeRoots` / `canRead` / `canWrite` (deny-first, boundary-safe).
- [ ] 13.2 Gate agent file tools through the guards — deferred until the agent gains file tools.

## 14. Verification

- [x] 14.1 `bun run typecheck` and `bun run lint` clean.
- [x] 14.2 Fresh-DB schema round-trip (tables, FKs, indexes, `UNIQUE(anchor_id, slug)`).
- [x] 14.3 Non-interactive command runs (`inf ls`, `inf status`, `inf project ls`, `--help`); interactive chat/picker flows are a manual step.
- [x] 14.4 `bun run format:file` on every touched file under `src/`.
