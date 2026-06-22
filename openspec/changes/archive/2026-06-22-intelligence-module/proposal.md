## Why

The chat backend and model-interaction engine live under `src/modules/session/`, a name that describes the persisted conversation store (sessions/messages/parts) rather than what the module actually does: talk to the model. The persisted store's real weight lives in shared layers (`db/`, `types/`) that the module only imports, so `modules/session/` is in practice the *AI-interaction* slice wearing a data-model name. Renaming it to `intelligence` makes the module boundary say what it owns, before more agentic features (tool calling, structured output) accrete onto the same misnamed slice.

## What Changes

- Rename the module directory `src/modules/session/` → `src/modules/intelligence/`, moving `chat.ts` (the streaming engine + model selection) and `sessions.ts` (the `inf sessions` list command) unchanged in logic.
- Update the two importers to the new path: `src/tui/app.tsx` (`chat`) and `src/cli/index.ts` (`listSessions`).
- Reword module-identity prose so comments stop naming "the session module" / "chat backend module": the header comment in `chat.ts` and any "homing them in a module" references that point at the old name.
- Update `CLAUDE.md` Project-structure and Modules sections that list `session/` (chat backend + `sessions` command) to `intelligence/`.
- The module stays **headless** — no `.tsx` moves into it. The chat UI (`tui/app.tsx`, `tui/layout/*`, `tui/hooks/status.ts`) is app-shell and stays in `tui/` per the existing "modules must never import `tui/`" rule.

## Capabilities

### New Capabilities
- `intelligence-module`: The vertical-slice module at `src/modules/intelligence/` that owns headless AI interaction — the model-streaming chat engine and the `sessions` text command — and is the public surface that the TUI and CLI import for chat. Captures the module's home, its headless constraint, and its acyclic dependence on `proxy`/`db`/`types`/`lib`.

### Modified Capabilities
<!-- None. The rename does not change any spec-level behavior. `chat-wiring` (session↔analysis link + launcher) and `data-model-*` (the session/message/part storage and types) keep their requirements unchanged; only the engine module's location moves. -->

## Impact

- **Code moved:** `src/modules/session/{chat.ts,sessions.ts}` → `src/modules/intelligence/`.
- **Importers updated:** `src/tui/app.tsx:12`, `src/cli/index.ts:68`.
- **Unchanged (verified):** `db/primary_query.ts` + `db/primary_mutation.ts` (session/message/part queries stay in `db/`), `types/session.ts` + `types/events.ts` (shared shapes stay in `types/`), `modules/proxy/` (transport stays its own module).
- **Docs:** `CLAUDE.md` module list; in-file header comments in the moved files.
- **No new dependencies. No behavior change. No DB or wire-format change.**
