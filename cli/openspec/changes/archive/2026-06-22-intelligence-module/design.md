## Context

`src/modules/session/` holds two files: `chat.ts` (the streaming model engine + model selection + system prompt + history mapping) and `sessions.ts` (the `inf sessions` list command). The persisted conversation store it nominally owns actually lives in shared layers the module only *imports*: queries/mutations in `src/db/primary_query.ts` + `src/db/primary_mutation.ts`, and shapes (`Session`/`Message`/`Part`, `BusEvent`) in `src/types/`. Per `CLAUDE.md`, those stay in `db/` and `types/` by rule, and the chat UI (`tui/app.tsx`, `tui/layout/*`, `tui/hooks/status.ts`) stays in `tui/` because "modules must never import `tui/`." The engine has exactly two importers: `src/tui/app.tsx:12` (`chat`) and `src/cli/index.ts:68` (`listSessions`).

## Goals / Non-Goals

**Goals:**
- Rename the module so its name states what it owns: AI interaction, not the data store.
- Preserve behavior and the existing layering rules exactly — pure structural move.

**Non-Goals:**
- No change to `chat()` / `listSessions()` logic, the DB schema, the wire format, or the bus contract.
- No `.tsx` in the module; no chat UI relocation.
- No new files (no premature `model.ts` split — model helpers stay inline in `chat.ts` until a second caller exists).
- No renaming of the `chat()` export or the `sessions` command.

## Decisions

- **Rename `session/` → `intelligence/`, not split into engine + transcript-store.** A separate `session/` module would hold only `sessions.ts` (one function), because the transcript's real weight is in `db/` + `types/`, which don't move. A one-function module fails the project's "no preemptive files / abstraction earns itself" bar. *Alternative considered:* `intelligence/` = generation only, `session/` = transcript domain — rejected as premature for the current file count.
- **Module stays headless.** The chat Solid components are app-shell (`app.tsx`) or the named "chat app-shell composition kit" (`tui/layout/*`); `CLAUDE.md` pins both in `tui/`. *Alternative considered:* a `modules/intelligence/components/` view folder — deferred; it would also collide with "modules must never import `tui/`" (a view needs `tui/theme.ts`), a tension to resolve only when the module actually grows its own feature-owned view.
- **`db/` and `types/` are untouched.** Moving session queries or the `Session`/`BusEvent` shapes into the module would invert the infra→feature dependency (`db/` and `lib/bus.ts` reference them). They stay shared, per `CLAUDE.md`.

## Risks / Trade-offs

- **[Stale references in prose/docs survive the move]** → Grep `src/` and `CLAUDE.md` for `modules/session` and "session module"/"chat backend"; reword the `chat.ts` header comment and the `CLAUDE.md` module list. `typecheck` catches code-path misses; comments need the manual grep.
- **[Concurrent in-progress changes touch nearby files]** (`add-workspace-context`, `add-keymap-engine` edit `tui/app.tsx`) → This change touches only line 12's import in `app.tsx`; conflict surface is one line, resolved by re-pointing the path.
- **[Behavior regression from an incomplete move]** → `bun run typecheck` + a manual chat round-trip confirm the two importers resolve and streaming still works; the move is content-preserving so risk is low.
