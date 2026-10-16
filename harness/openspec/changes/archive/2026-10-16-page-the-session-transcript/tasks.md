# Tasks

## 1. The page read

- [x] 1.1 Add `LoadPageOptions`, `TurnPage`, and `loadPage` to `ThreadHistory` in `src/memory/thread-history.ts`, with JSDoc (design D1, D2). Do the read as one statement (design D3), with the limit rule of design D4. Move the row mapping into one function that `loadAll` and `loadPage` call (design D5). Correct the JSDoc of `loadAll` and the comment above `readTurns`. Make sure that `bun run typecheck` passes.
- [x] 1.2 Export `LoadPageOptions` and `TurnPage` from `src/index.ts` beside `StoredMessage`. Add `loadPage` to each `ThreadHistory` fake in `src/app/message-assembly.test.ts`. Make sure that `bun run typecheck` passes.

## 2. The tests of the page read

- [x] 2.1 Add a `loadPage` describe block to `src/memory/thread-history.test.ts`. Cover each scenario of the delta of `harness-thread-history` that names the page read. Also cover an older page deep in a long thread, a cursor that a retract removed, and one statement for each page with `countingQuerier` (`src/__tests__/setup/counting-querier.ts`). For "The page read does not read the rows before its page", store an old row whose envelope does not parse with a direct SQL insert. Make sure that `bun run test:full src/memory/thread-history.test.ts` passes.

## 3. The measurement

- [x] 3.1 Measure the answer of the transcript route on a thread of 20 turns and on a thread of 500 turns. Time `loadPage` with a limit of 20 and no cursor, then `storedMessagesToChat` of its rows, then `JSON.stringify` of the messages. Time `loadAll` with the same replay for contrast. Give each turn a user row, an assistant tool call, a tool result of about 20 KB, and an assistant text row. Write the measurement as a one-time `*.test.ts` file in `harness/tmp/claude/` that uses `withSchema`. Run it with `bun run test:full ./tmp/claude/<file>`. Report the input sizes and the median of each path in the final report. Make sure that the 500-turn median of the page path is less than two times its 20-turn median.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run build`. Make sure that each command passes, and that `dist/` exports `loadPage` for the cli link.
- [x] 4.2 Run the full harness suite `bun run test:full` one time. For each failure, read its output. Show that it does not come from a file or a code path that this change touches, and report it. Fix each failure that does.
