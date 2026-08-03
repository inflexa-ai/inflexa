## 1. New session command

- [x] 1.1 Add a `newSessionFlow(ctx, seams)` action in `src/tui/commands.tsx`: guard on an open analysis; carry the same phase refusal as `openSwitchSession` (warn on `failed`, "still booting" info otherwise) for the by-id dispatch path; then `ctx.openSession(randomUUIDv7(), ctx.workingDir, analysis)` — synchronous body, no stale-analysis re-check, id minted inline.
- [x] 1.2 Register the palette entry: id `session.new`, title "New session", category Session, `enabled: ctx.analysis !== null && bootState().phase === "ready"`, placed beside `session.switch`.

## 2. Pinned creation row in the switch picker

- [x] 2.1 In `openSwitchSession`, widen the picker items to a union of `Thread` and a module-level `NEW_SESSION` sentinel; add the `pinned: true` row titled "Start a new session"; branch `onSelect` — the sentinel runs the same mint-and-swap as `session.new`, a `Thread` keeps the existing swap.

## 3. Tests

- [x] 3.1 Command tests in `src/tui/commands.test.ts` over the existing seam pattern: `session.new` swaps to a fresh id under the same analysis and working dir; a repeat invocation mints a different id; the pre-`ready` by-id dispatch raises the phase notice and leaves the scope unchanged; `enabled` gates on analysis + `ready`.
- [x] 3.2 Switch-picker tests: the pinned row is present with zero threads and under a non-matching filter query; selecting it calls `openSession` with a freshly minted id; selecting a thread row still swaps to that thread.

## 4. Verify

- [x] 4.1 Run `bun run format:file` on the touched `src/` files, then `bun run typecheck`, `bun run lint`, and `bun test` on the touched test files only.
