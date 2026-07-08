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

## F3 — Live check (task 5.2): BLOCKED on the config recreation

The scripted PTY pass exists (`scratchpad/sidebar_e2e2.exp`: fresh analysis → boot →
parity trigger → the 5s poll flips DATA PROFILE from "profiling" to completed with
the real file count → truthful "no runs"). It cannot run until the config exists
(minimal content: `harness.model` pin + `harness.sandboxImage: sandbox-base:latest`,
plus `inflexa setup --embeddings local` to restore an embedder). Two pre-runs
validated the change-1 preamble on the way: the interactive sandbox-image gate fired
correctly on normal stdio, and the bunfig-cwd coupling was confirmed (the TUI must be
spawned with cwd=cli/ so the Solid JSX preload applies).

## F4 — Watchlist for the eventual verify pass

- `RunBlock`'s `esc detach · ctrl+c abort` affordance line renders verbatim inside
  the runs dialog, where esc means close — cosmetic dishonesty from the verbatim
  reuse; candidate: an optional prop to suppress the footer.
- The design gallery hardcodes lines equivalent to `profileDetailLines` (avoiding an
  `app → commands → design_gallery` import cycle) — duplication to keep an eye on.
