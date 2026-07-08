# tui-sidebar-live — Findings

## F1 — Implementation verified offline: 566 cli tests, 0 fail

Store snapshot ladder, staleness guard, poll arming/disarming, section render states,
dialog line composition, and the exhaustive step-status mapping are all unit/render
tested (`sidebar_live.test.ts`, `sidebar.render.test.tsx`, `runs_dialog.test.ts`,
`app.test.ts`). Typecheck + eslint clean.

## F2 — INCIDENT: an unsandboxed `bun test` from the repo root destroyed real user state

While verifying, `bun test` was accidentally run from the **monorepo root**. There is
no root `bunfig.toml`, so `cli/bunfig.toml`'s `[test].preload` (which redirects
XDG_DATA_HOME/XDG_CONFIG_HOME into a mkdtemp sandbox before `env.ts` freezes its
paths) never ran — and the cli test files that call `freshDb()`/`resetDb()` resolved
`env.dbPath` to the developer's REAL `~/.local/share/inflexa/agent.db` and deleted it.
Collateral at the same timestamp: `~/.config/inflexa/config.json` (harness model pin,
sandbox image tag, embedding block incl. its API key) and the contents of
`~/.local/share/inflexa/models/` (the local GGUF).

**Survived intact** (verified by direct inspection): the proxy's own auth/config
(`~/.local/share/inflexa/cliproxy/` — the explicitly protected item), the Postgres
data dir, `~/.config/inflexa/prov_key.json` (the signing key), session trees, logs.

**Hardening landed in this change**: `src/test_support/preload.ts` now stamps
`INFLEXA_TEST_SANDBOX`, and `resetDb()` throws before any `rmSync` unless the marker
is present AND `env.dbPath` is inside it — an unsandboxed run now fails loudly
instead of deleting data (guard unit-tested; full suite green under the sandbox).

**Recovery state**: SQLite is disposable per the project owner's standing note and
re-migrates empty. The pg rows are now orphans (their SQLite analyses are gone) and
the surviving pgvector indexes carry the old embedding dimensions, so a pg reset is
the intended follow-up. Recreating `~/.config/inflexa/config.json` was BLOCKED by the
permission layer (out-of-repo write) — deliberately left to the user.

## F3 — Live check (task 5.2): PASSED after environment recovery + one live bug fixed

Environment restored (user recreated config via setup + pulled the sandbox image;
model pin + image tag wired into `harness`; postgres reset for the 384-dim embedder).
The live pass then delivered, in order:

1. **A real integration bug caught and fixed**: the parity trigger's "Profiling
   data…" toast appeared while DATA PROFILE sat on "not profiled" forever — the
   trigger creates the ledger row AFTER the ready-refresh read it as absent, so the
   active-work poll never armed and no idle-screen edge re-reads. Fix: the
   `triggered` outcome now pokes `refreshSidebarData` (seams + 5 unit tests); the
   flip chain (trigger → refresh → arm → flip) is unit-tested link by link.
2. **The profile workflow ran end-to-end through the new sandbox image** to
   `completed` in pg (staged the CSV, agent wrote a real summary + per-file
   description).
3. **Screen-captured verification (tmux)**: the sidebar rendered live ledger truth —
   `DATA PROFILE ✓ 1 file · 22m`, `RUNS no runs` (truthful empty), SESSION/ANALYSIS
   live — and `ctrl+x d` opened the profile details dialog showing status:
   completed, timestamps, the agent's real summary text, and the per-file line, with
   working scroll/close chrome. Clean quit.

**Method finding (structural, reusable)**: opentui PTY streams are cell-diff
paints — after the first full frame, strings are NOT contiguous in the byte stream,
so expect-style stream matching silently fails (observed: "DATA PROFILE" matched
only on the first paint; "1 files" never, also because the UI renders singular
"1 file"). The reliable technique is `tmux new-session -d -x/-y` + polling
`tmux capture-pane -p` — assertions run against the rendered GRID, not the stream.

## F3b — Original blocked state (superseded by the recovery above)

The scripted PTY pass exists (`scratchpad/sidebar_e2e2.exp`: fresh analysis → boot →
parity trigger → the 5s poll flips DATA PROFILE from "profiling" to completed with
the real file count → truthful "no runs"). It cannot run until the config exists
(minimal content: `harness.model` pin + `harness.sandboxImage: sandbox-base:latest`,
plus `inflexa setup --embeddings local` to restore an embedder). Two pre-runs
validated the change-1 preamble on the way: the interactive sandbox-image gate fired
correctly on normal stdio, and the bunfig-cwd coupling was confirmed (the TUI must be
spawned with cwd=cli/ so the Solid JSX preload applies).

## F4 — Adversarial verify: SHIP (0 critical, 9/9 hunts clean); 6 warnings all fixed

The verify assessed the store's staleness/poll machinery airtight (token bumped
before the runtime guard, re-checked after every await; single disarm slot with
teardown-before-arm; dispose covered). Warnings, all fixed pre-archive:

- **W1** false `esc detach · ctrl+c abort` footer inside the runs dialog → additive
  `hint` prop, dialog passes `hint={false}` (the affordance renders only where true).
- **W2** `runMark`/`shortRunName`/`relAge` duplicated across sidebar/dialog/app →
  single homes (`sidebar.tsx` exports the first two; `relAge` in `sidebar_live.ts`
  to avoid a `sidebar ↔ sidebar_live` cycle); one `never`-exhaustive `runMark`.
- **W3** gallery hardcoded a hand-kept copy of the profile detail lines →
  `profileDetailLines` moved to `sidebar_live.ts` (cycle-free), gallery calls the
  real function over a `mockDataProfile` fixture — drift structurally closed.
- **W4** a transient DbError mid-work disarmed the poll forever → `unavailable`
  snapshots now count as active work (bounded 5s self-heal; tests updated).
- **W5** changelog-phrased comment → static rationale.
- **W6** spec example `6m ago` vs the rendered `6m` → delta example corrected.
- Suggestions taken: invariant comments on the dialog's two escape hatches;
  `suspended_insufficient_funds` renders warn tone (actionable), `partial` muted.

Final: **573 cli tests, 0 fail; typecheck + eslint clean.**
