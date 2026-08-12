# Tasks: thread-eyes-into-the-start-tool

## 1. One predicate holds the rule

- [ ] 1.1 Export the rule of the gate from `src/app/spawn-report-session.ts` as one predicate over the deps that name the routes. `createReportSessionSpawn` calls it in place of its inline expression. The returned `ReportSessionSpawn` interface does not change.
- [ ] 1.2 Document the predicate. State that a caller reads it to skip work under a closed gate, and that the refusal itself stays with the spawn.
- [ ] 1.3 Add coverage: the predicate is true for each of the three routes, and it is false for a composition with none.

## 2. The start tool reads the spawn

- [ ] 2.1 Add `eyes?: AcquireEyes` to `StartReportSessionToolDeps`. Build the deps of the spawn one time, as a value, and give that same value to `createReportSessionSpawn` and to the predicate.
- [ ] 2.2 Replace the local gate of the tool with the predicate. Drop the `hasBrowserUrl` import, because the tool then reads no chrome config of its own.
- [ ] 2.3 Correct the doc of the deps. It states today that the browser endpoint is the one route to the eyes, and that is no longer true.
- [ ] 2.4 Add coverage: a bound seam with no browser endpoint starts a session, and a composition with no route gives the `no_browser` arm and runs no advice read.

## 3. The composition carries one answer

- [ ] 3.1 Add `eyes?: AcquireEyes` to `ConversationAgentDeps`, and forward it into `createStartReportSessionTool`.
- [ ] 3.2 Give the conversation agent the value that `resolveCompositionEyes` returns in the assembly. The resolution runs one time, thus both consumers read one answer.
- [ ] 3.3 Add coverage at the assembly: a bound seam reaches the start tool of the conversation agent.

## 4. The gates

- [ ] 4.1 Run `bun run format:file` on each changed source file.
- [ ] 4.2 Run `tsc -p tsconfig.json`, and run the targeted files of the changed modules against `CORTEX_TEST_PG_URL`.
- [ ] 4.3 Run `openspec validate thread-eyes-into-the-start-tool --strict`.
