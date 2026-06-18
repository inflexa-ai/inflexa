## Why

`DATA_MODEL.refined.md` decided the local data model: **Analysis** is the primary entity — the unit of work — living in a home folder (its **anchor**, identified by a UUID written into the folder so it survives moves/renames), referencing inputs by path (never copying), writing to a real, browsable output directory, and optionally grouped under a metadata-only **Project**. Chat sessions belong to an analysis. None of this existed yet; the repo had only the chat/session/auth/proxy/theme infrastructure.

This change lands that entire model and the CLI that drives it — the "`cd` to the data, run `inf`, chat" flow — as a set of vertical-slice modules. It is the migration of thirteen originally-separate change proposals (`data-model-domain-types`, `data-model-db-migrations`, `data-model-db-access`, `anchor-marker`, `anchor-resolve`, `path-resolution`, `analysis-service`, `context-resolution`, `chat-wiring`, `cli-core`, `projects`, `move-backstop`, `write-boundary`) into a single applied change, with the structure and conventions adapted to this repository.

## What Changes

- **Domain types** (`src/types/`, grouped by domain): `Anchor`, `Project`, `Analysis`, `AnalysisInput`, `AnchorMarker`, and the id aliases over the single uuidv7 scheme. Names are the branded `Str256`; references are `IdOrName`.
- **Schema** (`src/db/primary_migrations.ts`): a single forward-only baseline (not layered deltas) with **columnar** `anchors`/`projects`/`analyses` tables (one column per field, identity → core → FK), a blob-free `analysis_inputs` table, the `sessions.analysis_id` link, and lookup indexes. Tables are declared parent-before-child.
- **DB access** (`src/db/primary_query.ts`, `primary_mutation.ts`): typed `Result`-returning reads/writes over the new tables, id-or-name resolution in one id-priority query (`findAnalysesByRef`/`findProjectByRef`), targeted updates, and count/recovery helpers.
- **Anchor layer** (`src/modules/anchor/`): the on-disk `.inf/id` marker (`marker.ts`), on-demand anchor creation + lazy UUID→path reconciliation + copy/move classification + passive `recoverAnchors` (`anchor.ts`), and the explicit move backstop `repair`/`relocate`/`prune` (`backstop.ts`).
- **Analysis layer** (`src/modules/analysis/`): input classification/resolution (`input.ts`), output-dir resolution/creation (`output.ts`), the create/list/find lifecycle (`analysis.ts`), context resolution (`context.ts`), the read-only command actions (`ls.ts`, `open.ts`, `status.ts`, `set_project.ts`), and the advisory write boundary (`boundary.ts`).
- **Project layer** (`src/modules/project/project.ts`): create/list, attach/clear an analysis's project, `--project` by id or name.
- **Chat wiring**: `createSession` links to an analysis via the column; `launchChat` (and `launchNew`/`launchResume`/`launchDefault`) in `src/tui/launch.tsx` open a chat for a resolved analysis.
- **CLI registry** (`src/cli/index.ts`, commander): the default action plus `new`, `ls`, `resume`, `open`, `status`, `project new|ls`, `analysis set-project`, `repair`, `relocate`, `prune`.
- **Env** (`src/lib/env.ts`): `env.outputFallbackDir` + its `--help` doc entry.

## Capabilities

### New Capabilities

- `data-model-types` — the cross-cutting entity/marker types every later slice imports.
- `data-model-storage` — the columnar SQLite schema (single baseline migration).
- `data-model-db-access` — typed `Result`-returning read/write functions over the tables.
- `anchor-marker` — the on-disk `.inf/id` folder-identity marker (filesystem-only).
- `anchor-resolve` — on-demand anchor creation, lazy UUID→path reconciliation, copy/move classification, passive recovery.
- `path-resolution` — input-ref classification/resolution and output-dir resolution/creation.
- `analysis-service` — the create/list/find analysis lifecycle.
- `context-resolution` — precedence-based resolution of what bare `inf` operates on, plus a description.
- `chat-wiring` — analysis-linked sessions and the analysis-aware chat launcher.
- `cli-core` — the core user-facing commands wired to the commander registry.
- `projects` — optional metadata-only grouping and `--project` resolution.
- `move-backstop` — explicit move/rename recovery (copy clone/fork deferred).
- `write-boundary` — the readable/writable roots and deny-first guards (gating deferred).

### Modified Capabilities

<!-- None at the requirement level. The createSession signature gains an analysisId, and env gains an additive path — neither changes an existing capability's requirements (primary-storage, sqlite-migrations, theme-system, auth-*, telemetry, logging, event-bus, result-types). -->

## Impact

- New: `src/types/{anchor,project,analysis}.ts`; `src/modules/anchor/{marker,anchor,backstop}.ts`; `src/modules/analysis/{input,output,analysis,context,boundary,ls,open,status,set_project}.ts`; `src/modules/project/project.ts`.
- Edited: `src/db/{primary_migrations,primary_query,primary_mutation}.ts`; `src/lib/env.ts`; `src/cli/index.ts`; `src/tui/launch.tsx`; `src/db/primary_mutation.ts` `createSession` signature.
- No new dependencies (`commander`, `@clack/prompts`, `neverthrow`, `bun:sqlite` already present).
- **Adapted from the original proposals** (recorded in design.md): columnar storage instead of JSON `data` blobs; one merged migration instead of an appended v2; `randomUUIDv7()` everywhere instead of ULID/`crypto.randomUUID()`; vertical-slice modules + a `tui/` presentation layer instead of a flat `src/cli/`; commander instead of cac; clack prompts instead of `readline`; `Str256`/`IdOrName` domain types; identity → core → FK field ordering. **Dropped from the original model**: `archivedAt`/archive commands, `goals`, `syncedAnalysisId`, `driveId` (see design.md → Deferred & dropped).
- Verified by `bun run typecheck`, `bun run lint`, a fresh-DB schema round-trip, and non-interactive command runs.
