# Design — unify-analysis-workspace

## Context

Two disconnected "output" worlds exist: the harness session tree (`env.sessionsDir` → `~/.local/share/inflexa/sessions/<analysisId>/…`, all real artifacts) and the analysis output directory (`.inflexa/analyses/<slug>/`, provenance exports only — the directory `inflexa open` reveals). The split was consciously deferred by the archived `embed-harness-runtime` design (D2: one global `sessionsBasePath` closed over at DBOS registration). The paired harness change `add-workspace-root-resolver` dissolves D2 by replacing the closed-over base *string* with a closed-over *resolver function*; this change supplies the CLI realization and deletes the second world.

Explored and decided with the user (2026-07-10): slug-keyed root with no UUID segment; no fallback root; no output override; no `.gitignore`; rename moves the tree; mid-run moves unsupported.

## Goals / Non-Goals

**Goals:**
- One rule: an analysis's files live at `<anchorPath>/.inflexa/analyses/<slug>/` — inputs, run artifacts, reports, previews, provenance exports.
- `inflexa open` reveals the directory the results are actually in (closes inf-cli#54).
- Non-writable locations fail loudly and early, with an actionable message.

**Non-Goals:**
- DB-resident data (SQLite rows, Postgres/DBOS tables) — files only.
- Roots 3–5 of the write-map (XDG support files, config dir, container `/tmp`) — unchanged.
- Migration of existing session trees — the app is unshipped; stale `~/.local/share/inflexa/sessions/` data is abandoned, not moved.

## Decisions

### D1. The workspace root is derived, never persisted

`workspaceRoot(analysis) = join(resolveAnchorPath(analysis.anchorId), ".inflexa", "analyses", analysis.slug)`, computed live on every resolution. Nothing is persisted: anchors exist precisely because folder paths change, and a stored absolute path would rot on every anchor move. The `analyses.output_directory` column is deleted rather than repurposed.

- *Alternative — pin the resolved root on the analysis row*: rejected; it re-creates the desync class the anchor system exists to solve, and with the fallback and override both gone there is nothing left that derivation can't answer.

### D2. Failure is an error, not a redirect

When the anchor is unresolvable or its folder is not writable, resolution returns an err that surfaces as an actionable message ("the analysis's folder … is not writable; move it somewhere writable or pick another folder"). Enforced at the two moments that matter: **creation** (`createAnalysis` fails before inserting anything — writability is a precondition of the analysis existing) and **launch/staging** (profile, run, chat boot fail before any side effect, consistent with the existing no-litter ordering). Passive flows (list, status) never touch the workspace and therefore never hit the check.

- *Alternative — keep the XDG fallback*: rejected by the user; a silent redirect is the confusion this change exists to remove. Users with read-only data reference inputs from anywhere (hardlink/copy staging) and anchor the analysis in a writable folder.

### D3. The CLI realizes `resolveWorkspaceRoot` from DB state

The seam realization looks up the analysis row (slug + anchorId) and resolves the anchor's live path — durable state, so a DBOS-recovered workflow on a fresh process resolves correctly (the seam contract in the harness change requires exactly this). It is injective by construction: `UNIQUE (anchor_id, slug)` — a constraint whose stated rationale ("outputs live at `…/analyses/<slug>/`") finally protects the tree it was written for. Resolution failure inside a workflow surfaces per the harness contract (throw across DBOS steps).

Wiring: `runtime.ts` passes the realization into every dep bundle that previously took `sessionsBasePath: env.sessionsDir` (sandbox client, workspace filesystem, composition/data-profile/conversation deps).

### D4. Rename is a lock-guarded directory move

`renameAnalysis` regenerates the slug, so the palette rename action becomes: acquire the per-analysis instance lock → `rename()` `analyses/<old>/` → `analyses/<new>/` → update the row (one deliberate action; the DB write and the move stay adjacent so a crash window leaves at most a re-derivable mismatch, healed per the desync rule below). A rename while the lock is held (active run/chat) is refused with the same message family as other lock conflicts. Mid-run *anchor* moves stay unsupported — the bind mount pins the old path; the user stops the run or waits.

### D5. Missing trees heal per the existing desync rule

The workspace lives on the user's disk; they may delete it. A missing tree is a normal condition: passive reads degrade (empty run list, `open` recreates the bare directory via `ensureOutputDir`), deliberate actions that need prior artifacts fail with an actionable message. Staged inputs are re-materialized by the next launch's mirror reconciliation — staging is already idempotent from DB-recorded inputs.

### D6. Staging self-exclusion is now load-bearing

An anchor-folder directory input now contains the workspace itself (`.inflexa/` is inside the anchor). The existing noise-dir exclusion of `.inflexa` is what prevents a workspace from staging its own outputs (and previous staged inputs) recursively — it graduates from hygiene to invariant, and gets a spec scenario. Hardlink staging becomes the common case (same filesystem as the source) rather than the lucky one.

## Risks / Trade-offs

- [Users' project dirs accumulate large `data/` + `runs/` trees, and git users may commit them] → accepted deliberately; no `.gitignore` is written until real usage feedback exists (user decision, 2026-07-10). `inflexa open` making the location visible is itself the mitigation for "where did my disk go".
- [Anchor folder on a filesystem Docker can't bind-mount (network mount, unshared path on macOS)] → pre-existing constraint class (the XDG dir had equivalents); surfaces as the sandbox-creation error path. Not newly mitigated here.
- [Rename crash window between dir move and row update] → both operations are local and adjacent; a mismatch resolves as "missing tree" (D5) plus an orphan dir the user can see and delete. Accepted over introducing a journal for a palette action.
- [Slug collision in the fallback dir] → moot: the fallback is deleted, and in-anchor collisions are excluded by `UNIQUE (anchor_id, slug)`.

## Migration Plan

None for data (unshipped). Landing order: harness `add-workspace-root-resolver` first, then this change consumes the new `@inflexa-ai/harness` surface (`file:../harness` — no publish step). Both changes may share one working branch; the CLI compiles only after the harness's dep-type change lands, which the compiler enforces.

## Open Questions

None blocking. Naming inside the CLI (`resolveOutputDir` → e.g. `resolveWorkspaceRoot`/`ensureWorkspace`) is an implementer's choice; specs use "workspace" language while keeping existing requirement headers stable where behavior merely re-scopes.
