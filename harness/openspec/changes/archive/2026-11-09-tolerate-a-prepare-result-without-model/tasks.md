# Tasks

## 1. The recovery test

- [x] 1.1 In `src/app/test/chat-turn-workflow.test.ts`, add a recovery test for a thread with a pinned model. The test crashes the turn after its prepare step. It removes `model` from the stored `chat-turn.prepare` output, and then it recovers the turn. Make sure that the test fails on the current code because the turn gives `undefined` to `withModel`.

## 2. The fix

- [x] 2.1 In `runTurnWorkflow` (`src/app/chat-turn-workflow.ts`), read the replayed `model` as `opening.model ?? null`. Make sure that the test of 1.1 passes, and that the turn ends as `done` on the provider of the host.
- [x] 2.2 Run `bun run format:file` on the changed files, the typecheck, and `src/app/test/chat-turn-workflow.test.ts` and `src/app/test/chat-turn.test.ts`. Make sure that each passes.
