## 1. The append carries the duration

- [x] 1.1 Read the landed harness append surface, and pass the measured turn duration beside the usage rollup.
- [x] 1.2 Tests: the append call carries the duration, and an aborted turn passes none.

## 2. The reload renders the duration

- [x] 2.1 Map the stored duration onto the assistant header in the transcript load.
- [x] 2.2 Keep the absent case absent: an old row renders its other facts and no duration.
- [x] 2.3 Tests: the reloaded header carries the stored duration, and an old row carries none.

## 3. The entry sits below its request

- [x] 3.1 Change `slotFor` in `cli/src/tui/components/chat.tsx`: the entry lands after the first assistant message at or past the first mark above the anchor.
- [x] 3.2 Keep the end arm for a live spawn and an anchor past every pair, and the top arm for an anchor below the window.
- [x] 3.3 Tests: the reloaded transcript places the entry after the reply, the live spawn stays at the end, and the window arms hold.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on each changed source file, then `bun run typecheck` in `cli` against the linked harness.
- [x] 4.2 Run the targeted test files of the changed surfaces alone, never the full suite.
