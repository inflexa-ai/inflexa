# Tasks

## 1. The connection check knows the refused connection of Bun

- [x] 1.1 In `src/providers/test/errors.test.ts`, add a test of the measured Bun shape of a refused connection: an `APICallError` of `@ai-sdk/provider` with no status, whose cause is a `TypeError` with the code `ConnectionRefused`. Assert a retryable `provider` classification, and assert that `modelFailureOf` gives `outage`. Run the file and make sure that the test fails on the current code for the reason under test.
- [x] 1.2 In the same file, add a test of the measured Bun shape of a reset: a `TypeError` with the code `ECONNRESET` and the Bun message, with no status. Assert a retryable `provider` classification. Run the file.
- [x] 1.3 In `src/app/test/chat-turn-workflow.test.ts`, add a test of a turn whose model request fails with the measured Bun shape of a refused connection. Assert that the turn waits in `retrying` with the cause `outage`, then stop the turn. Run the file and make sure that the test fails on the current code for the reason under test.
- [x] 1.4 Add `ConnectionRefused` to `CONNECTION_ERROR_CODES` in `src/providers/errors.ts`, and name Bun in the comment of the list. Run `bun test src/providers/test/errors.test.ts src/app/test/chat-turn-workflow.test.ts` and make sure that each file passes.

## 2. The stream of a turn carries each retry of a model request

- [x] 2.1 In `src/app/test/chat-turn-workflow.test.ts`, add a test of a turn whose model request fails with `503` two times through the real envelope, and then gives a reply. Hold each attempt of the scripted model on a promise, thus each reader is open before the part that it must get live:
  - The first attempt waits until the first reader has its first frame.
  - The second reader opens when the first reader gets the retry part 1.
  - The second attempt waits until the second reader has its first frame.
  - The third attempt, the reply, waits until each reader has the retry part 2.

  Assert that each reader gets the retry parts 1 and 2 of one request id. Assert that the stored transcript of the turn holds no `data-model-retry` part. Run the file and make sure that the test fails on the current code because no retry part arrives.
- [x] 2.2 Change the emit of `createTurnStreamWriter` (`src/loop/chat-stream.ts`) as design D2 tells. A transient frame of a step goes to the `toolWriter` of the turn stream writer. Each other frame of a step keeps the library `toolWriter()`. Run `bun test src/app/test/chat-turn-workflow.test.ts src/loop/test/chat-stream.test.ts src/loop/test/run-loop.test.ts` and make sure that each file passes.
- [x] 2.3 Correct the comment of `chunkOfFrame` in `src/loop/chat-stream.ts` (design D5). Make sure that each comment that the patch adds or changes obeys the comment rules of the repository.

## 3. Verification of the package

- [x] 3.1 Run `bun run format:file` on each changed file in `src/`. Then run `bun run typecheck` and `bun run lint` on the changed files, and make sure that each passes.
