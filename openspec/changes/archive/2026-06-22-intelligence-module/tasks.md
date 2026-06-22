## 1. Move the module

- [x] 1.1 `git mv src/modules/session src/modules/intelligence` (preserves history for `chat.ts` and `sessions.ts`)
- [x] 1.2 Confirm `src/modules/session/` no longer exists and `src/modules/intelligence/{chat.ts,sessions.ts}` do

## 2. Update importers

- [x] 2.1 `src/tui/app.tsx`: change the `chat` import from `../modules/session/chat.ts` to `../modules/intelligence/chat.ts`
- [x] 2.2 `src/cli/index.ts`: change the lazy `import("../modules/session/sessions.ts")` to `import("../modules/intelligence/sessions.ts")`
- [x] 2.3 `grep -rn "modules/session" src` returns no matches

## 3. Reword module-identity prose

- [x] 3.1 `src/modules/intelligence/chat.ts`: update the header comment so it no longer calls itself "the chat backend" of the session module (describe it as the intelligence module's model-interaction engine)
- [x] 3.2 `src/types/events.ts`: re-read the "homing them in a module" comment; reword only if it names the session module by the old identity
- [x] 3.3 `grep -rn "session module\|chat backend" src` reviewed; remaining hits are intentional (none should imply the old module path)

## 4. Update docs

- [x] 4.1 `CLAUDE.md` Project-structure section: change the `src/modules/<domain>/` listing's `session/` (chat backend + `sessions` command) entry to `intelligence/`
- [x] 4.2 `CLAUDE.md` Modules section and any other `session/`-as-module mention: update to `intelligence/`

## 5. Verify

- [x] 5.1 `bun run typecheck` passes (both importers resolve)
- [x] 5.2 `bun run lint` passes
- [x] 5.3 `bun run format:file` on the moved + edited `src/` files (`src/modules/intelligence/chat.ts`, `src/modules/intelligence/sessions.ts`, `src/tui/app.tsx`, `src/cli/index.ts`, and `src/types/events.ts` if edited)
- [x] 5.4 Manual smoke: launch the TUI, send a message, confirm the assistant streams and persists (engine works at the new path); run `inf sessions` and confirm it lists sessions
