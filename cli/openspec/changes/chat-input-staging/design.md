## Context

An analysis's inputs are DB references (`analysis_inputs` rows: `path`, `is_dir`, `analysis_id`, `anchor_id`) that `stageInputs` later materializes into `{workspaceRoot}/data/inputs/local/…` as the `StagedInput` manifest the embedded harness profiles. Today those rows are created in exactly one production place — the TUI file picker (`src/tui/commands.tsx`). The dev-only `inflexa profile` boots a runtime and stages; no shipped command adds inputs. So when a user references files in the anchored folder mid-chat, the agent has no way to see them (harness workspace tools are scoped to the analysis tree; the anchor folder resolves out of scope) and no way to register them.

Two existing subsystems constrain how a fix may reach the running chat:

- **The event `Bus` is a plain in-process `EventEmitter`** (`src/lib/bus.ts`). A separate process's `prov.*` emissions never reach a live TUI's subscribers — including the profile-parity drift watcher (`watchProfileParity`) and the provenance recorder.
- **Provenance is a per-process, in-memory, signed hash chain** (`src/modules/prov/prov.ts`: `liveDocs`/`chainHashes`, Ed25519-signed per `prov-chain`/`prov-signing`), persisted to `analyses.provenance*`. Its integrity depends on the `analysis-lock` making exactly one process the chain's writer (the two-recorder fix of #37). The recorder assumes — does not itself acquire — the lock.

## Goals / Non-Goals

**Goals:**

- Let the conversation agent enumerate candidate files in an analysis's anchor/launch folder.
- Let inputs be added after creation from three surfaces over one shared operation: a terminal subcommand, an in-process agent tool, and the existing file picker.
- Preserve the single-writer provenance invariant: adding inputs can never fork the signed chain.
- Trigger re-profiling through the existing parity engine, with no new trigger and no runtime boot from the add path.

**Non-Goals:**

- Staging or profiling from the subcommand (register-only). Materialization stays owned by `input-staging`; re-profiling by the parity engine.
- Widening the harness workspace file tools to read outside the analysis tree.
- The harness conversation-prompt edits (a companion `harness/openspec` change) — the primary guidance rides in the new tools' descriptions.
- Reworking the provenance recorder's storage or signing.

## Decisions

### D1: The mid-chat add is an in-process host tool, not a `run_inflexa` subprocess

The agent already drives the CLI through `run_inflexa`, and reusing one command surface is attractive. But a subprocess `inflexa inputs add` for an analysis a chat holds open is unworkable on two independent counts: its `prov.input_added` fires on the child's own in-process `Bus`, so the live TUI's parity watcher never re-checks (the profile silently stays stale); and it would be a second provenance writer, which the `analysis-lock` either refuses (the TUI holds the lock) or, if bypassed, lets fork the signed chain (the TUI's stale `chainHashes` overwrite the child's signed revision, dropping the event). Therefore the mid-chat path runs **in the TUI process**, where the one recorder appends coherently and the in-process `prov.input_added` drives parity edge 2 for free.

*Alternative considered — subprocess subcommand + an "edge 4" parity re-check after every `run_inflexa` action.* Rejected: an edge-4 re-read can repair the profile (a recompute from the DB), but it cannot repair provenance, which is an append-only signed chain, not a recompute. The stronger constraint decides.

### D2: Reuse the existing add/remove operations; add thin callers

`addInputs`, `removeInput`, and `applyInputsDiff` already exist in `src/modules/analysis/analysis.ts` — `addInputs` inserts `analysis_inputs` rows and emits `prov.input_added` (`analysis.ts:135`), `removeInput` deletes a row and emits `prov.input_removed` (`:154`), and `applyInputsDiff` batches add-then-remove (`:179`) — and the TUI file picker / "Manage inputs" flow already uses them. This change adds thin callers of the same functions: the `inputs add`/`inputs remove` subcommands and the in-process agent tool. Nothing re-implements mutation. The agent tool is a third caller, not a third implementation, and it exists only because D1 forbids routing the agent through the subprocess.

### D6: Add is symmetric with remove; validation differs by direction

The agent must be able to remove inputs, not just add — matching the TUI's "Manage inputs" / "Remove input" commands. The agent gets one in-process tool that both adds and removes (mirroring `applyInputsDiff`), plus a read-only listing of the current registered inputs so it knows what to remove (the launch-dir tool shows on-disk candidates; the registered set may include inputs outside the anchor). Validation is direction-specific and already correct in the shared code: **add verifies on-disk existence** — `addInputs → classifyInputPath` stats each path and rejects a missing one, short-circuiting the whole batch so no dangling ref is stored (`analysis.ts:113-117`, `input.ts`), which is exactly what stops the agent registering a file a user merely named; **remove matches the registered set**, not the filesystem, so an input whose file was moved/deleted can still be removed. One refinement the new surfaces owe: `classifyInputPath` returns the not-found case as a generic `query_failed` `DbError` (the errno rides in `cause`), so the subcommand/tool boundary SHALL translate it to a clear "no such file: <path>" message rather than surfacing a storage error.

### D3: Register-only; re-profiling stays with the parity engine

The add path writes DB rows and emits the event; it never stages or profiles. `ensureProfileAtParity` is set-based (`enumerateInputSignatures` vs the profiled set at stat cost), so a new row is detected as drift and `watchProfileParity` reprofiles: edge 1 on the next open (the terminal case), edge 2 on the in-process `prov.input_added` (the mid-chat case). Keeping staging out of the add path also avoids booting a second runtime and avoids `reconcileStagedTree` deleting files a live sandbox is reading.

### D4: Input-add joins the analysis-lock discipline (at the caller, not the recorder)

The lock's purpose already is "one process mutates an analysis at a time, so provenance has one writer." Both `inputs add` and `inputs remove` (each emits provenance) acquire the analysis lock and refuse if a live instance holds it (matching the existing open/switch refusal). The in-process agent tool needs no new acquire — the chat already holds the lock. So the new terminal subcommands are the only surfaces adding a lock step, wrapping their `addInputs`/`removeInput` calls.

The discipline stays **caller-side**, not a recorder-level assertion. An audit of all 10 `prov.*` emit sites confirmed every mutation surface holds the target analysis's lock *except* the analysis-creation path (`prov.analysis_created` at `analysis.ts:235`, and seeded `prov.input_added` at `:135`), which legitimately emits lock-free: the id is a freshly-minted UUIDv7 no other process can contend, so no second writer can exist. A blanket "recorder refuses to append without the lock" guard would therefore break legitimate creation emits. The invariant is upheld by making each *mutating surface* acquire the lock, which the new subcommand now does.

### D5: The launch-dir listing is a read-only host tool, not a harness change

Listing the anchor/launch folder is a host concept (the harness has no notion of a launch directory, and its file tools are analysis-scoped by design). The CLI injects a read-only tool through the existing `hostTools` seam — the same mechanism as `run_inflexa` — reusing the staging walk's noise-directory rules so it never enumerates `.git`/`.inflexa`/tooling noise. No harness code changes.

## Risks / Trade-offs

- **A prov-emitting path forgets the lock** → the chain forks silently. Mitigation: route every add through the existing `addInputs`, and have the one new lock-free surface (the subcommand) acquire the lock around it. The emit-site audit found all mutation surfaces already lock-disciplined (only the fresh-id creation path is lock-free, and safely so), so no recorder-level change is needed.
- **Terminal `inputs add` while a chat is open is refused** → a user adding from a second terminal is told to add in the open window. Accepted: this is the same single-instance rule the open/switch flow already enforces, and it is exactly what protects the chain.
- **Agent adds a wrong or unintended file** → inputs mutate silently. Mitigation: classify the add `approval` (always confirm); the launch-dir tool is read-only and cannot mutate.
- **Register-only means a brief window where inputs exist but the profile is stale** → parity closes it (edge 1/edge 2), but a crash between register and reprofile leaves drift until the next open, which the parity check then repairs. Accepted.

## Open Questions

- **Resolved by audit** — do existing `prov.*` emit sites run without the lock? Of 10 sites, only the analysis-creation emits are lock-free, and safely (fresh UUIDv7, no possible second writer). This change stays scoped to the new add surfaces; no recorder-level assertion.
- **Pre-existing, out of scope (flag only)** — the run-engine emitters are process-global (wired once at `runtime.ts:868`) and stamp the workflow's `analysisId`. If DBOS boot recovery replays an in-flight workflow for an analysis this process did not open, those emits land without *that* analysis's per-analysis lock; single-writer still holds because the machine-wide `RUNTIME_LOCK_KEY` admits one DBOS engine, so safety there rests on the runtime lock, not the analysis lock. Noted for the record; not addressed here.
- Should the subcommand accept absolute host paths (which staging supports as anchorless inputs) or only anchor-relative paths? Leaning: accept both, mirroring `stageInputs`; the launch-dir tool surfaces anchor-relative candidates.
