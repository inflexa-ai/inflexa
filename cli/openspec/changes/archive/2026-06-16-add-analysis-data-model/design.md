## Context

This change implements the `DATA_MODEL.refined.md` model in inflexa. It originated as thirteen separate change proposals authored against an earlier codebase (`inf-cli`); during migration the repository's structure and conventions changed substantially, so the design recorded here is inflexa's as-built version, with the notable divergences from the original proposals called out. The pre-existing infrastructure — `bun:sqlite` with a versioned/transactional migration runner, `neverthrow` `Result`s via `tryQuery`/`tryMutation`, the Solid+opentui TUI, the Auth0/proxy/session stack — is the foundation this builds on.

## Goals / Non-Goals

**Goals:**

- The full local data model: anchors (invisible, UUID-keyed folder identity), analyses (the primary entity), optional projects, move-resilient input references, real output directories, and an advisory write boundary.
- The end-to-end Stage-1 flow: `cd` to data → bare `inf` resolves context (loudly) → open/pick/start an analysis → chat, with `new`/`ls`/`resume`/`open`/`status` and the move backstop.
- Move/rename resilience by construction: identity lives in the folder (a UUID marker), the DB caches only a hint, and reconciliation self-heals.
- Inputs referenced, never copied; outputs the sole writable target.
- Zero new dependencies.

**Non-Goals:**

- Cloud sync (Stage 4): Drives/Mounts, `driveId`, `syncedAnalysisId` — deliberately absent.
- OS-level sandboxing — the write boundary is advisory (application-layer).
- An agent file-tool implementation — only the boundary library and its future gating point.

## Decisions

**1. Columnar entity tables, not a JSON `data` blob.** `anchors`, `projects`, and `analyses` store one typed column per field; only the chat tables (`sessions`/`messages`/`parts`) keep a `data` blob. Rationale: these entities are filtered, ordered, and joined by their fields (anchor by id, analyses by anchor/project, ordered by `created_at`), so columns are the natural shape — `JSON.parse` per row and `json_extract` filters are avoided. *(Diverges from the original proposals, which stored `anchors`/`projects`/`analyses` as `id + data` JSON.)*

**2. One forward-only baseline migration, declared parent-before-child.** The schema is a single `version: 1` rather than an appended `version: 2`, because there is no production SQLite to upgrade in place. Tables are declared anchors → projects → analyses → analysis_inputs → sessions → messages → parts so every FK is a backward reference. *(Diverges from the original "append v2".)*

**3. `randomUUIDv7()` is the single id scheme, minted inline.** Every id — DB rows, the anchor marker, event ids — is a time-sortable uuidv7 minted at the call site; there is no `makeID()` wrapper, and neither ULID nor `crypto.randomUUID()` (v4) is used. The `ID` alias documents the contract once. *(Diverges from the original ULID `newId()` for rows + `crypto.randomUUID()` for markers.)*

**4. Identity → core → FK field ordering, everywhere.** Tables, row types, `COLS`/`fromRow`, INSERT/UPDATE column lists and their bound params, the entity types, and the function params that carry them all order fields as the identity triple (`id, created_at, updated_at`) first, then core data, then foreign keys last (`anchor_id`, `project_id`). An `analysis_inputs` row has no identity triple (it is a reference, not an entity).

**5. Vertical-slice modules with a `tui/` presentation layer.** Logic + its text-command actions live under `src/modules/<domain>/` (`anchor`, `analysis`, `project`); chat-opening actions (`launchDefault`/`launchNew`/`launchResume`/`launchChat`) live in `src/tui/launch.tsx` because opening a chat is presentation orchestration (views may import module logic; modules never import `tui/`). The commander registry in `src/cli/index.ts` lazy-imports each action. *(Diverges from the original flat `src/cli/*.ts` + `src/analysis/`/`src/anchor/` layout, and from cac.)*

**6. Id-or-name resolved in one id-priority query.** `findAnalysesByRef`/`findProjectByRef` resolve a reference with a single `WHERE id = $ref OR name = $ref ORDER BY (id = $ref) DESC` query — never read-by-id-then-by-name, never load-all-and-`.find`. `matchAnalysis` reshapes the analysis candidate set into `{ analysis, others }` to surface name collisions; `findProjectByRef` returns the single match directly because `projects.name` is `UNIQUE` (no wrapper).

**7. Lazy reconciliation + passive recovery, no-litter.** `resolveAnchor` self-heals a moved folder on the next lookup (cached-path marker → cwd/ancestor → bounded search). `recoverAnchors` runs that across anchors at chat launch — recovery only, never creation — so a passive flow (opening the TUI) never writes a marker or row. Minting is reserved for deliberate actions (`inf new`, the create path).

**8. Names validated once at the boundary as `Str256`.** Analysis and project names are the branded `Str256` (1–256 code points, trimmed), validated at the CLI boundary via `str256` and re-branded with `asStr256` when read back from the DB, so the entity types can keep `name` non-null.

**9. The write boundary is advisory and structural.** `computeRoots` yields a single writable root (the output dir) and readable roots (inputs + output); `canRead`/`canWrite` are deny-first with boundary-safe containment (`/a/bc` is not inside `/a/b`). It is an application-layer contract; OS sandboxing is out of scope.

## Deferred & dropped

These appear in the original proposals/data model but are intentionally **not** built here (and are recorded so the gap is explicit):

- **Archive (projects and analyses).** No `archivedAt` column, no `archive` mutations, no `inf project archive`, no `archived_at IS NULL` filtering. A migration audit found project archive is in the source data model (`DATA_MODEL.refined.md`) and so reads as an accidental omission rather than a deliberate cut; it is left for a follow-up decision and is therefore absent from these specs (which describe what is built).
- **Copy clone/fork resolution.** Copied folders are detected (`classifyMarkerSighting` → `copy`, surfaced as a `copy` context) but the re-mint-and-clone vs fork flow is not implemented; the default command directs the user to `inf repair`/`inf relocate`. Marked `TODO(extend)`.
- **`relocate` by id/name → by path.** The single-anchor relocate takes `<fromPath> <toPath>` (path-addressed), not `<id|name> <new-path>`. Rationale: re-pointing a folder's identity is the anchor's job, and an anchor outlives any analysis homed in it.
- **Cloud-sync fields.** `driveId` (Anchor), `syncedAnalysisId` (Analysis) — Stage-4 sync mapping, deliberately omitted.
- **`goals` column.** In the model as a placeholder; intended to live in a user-editable `<anchor>/.inf/<slug>/goals.md` later, so the column is not carried.
- **Agent file-tool gating.** The boundary guards exist but are not yet wired into the chat backend (no agent file tool exists). The forward-looking `TODO(extend)` marker at the gating point in the chat backend was not carried over and can be re-added when the tools land.

## Risks / Trade-offs

- **Dropped archive diverges from the source data model** → recorded above; restoring it is a contained follow-up (column + types + filters + two mutations + the `project archive` command).
- **Copy footgun without resolution** → mitigated by never auto-resolving: a copy is detected and the user is steered to the backstop, so the original's records are never silently mutated.
- **Advisory (not enforced) write boundary** → acceptable while no agent file tool exists; the guards are the mandated gating point when tools arrive.
- **Columnar schema is less flexible than a blob** → accepted: the entities' fields are stable and query-shaped; the blob remains where shape is genuinely application-internal (chat).

## Migration Plan

Single in-repo change; no data migration (no production SQLite). A fresh DB gets the whole schema from the single baseline migration. Reverting is reverting the change.

## Open Questions

- Whether to restore the archive capability (project, and optionally analysis) to match `DATA_MODEL.refined.md`, or to formally drop it from the model. Tracked as a follow-up decision; not blocking.
