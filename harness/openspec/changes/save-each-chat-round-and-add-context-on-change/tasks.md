# Tasks

Each path is relative to `harness/`. A path that starts with `cli/` is relative to the root of the repository.

This change builds on `update-the-provider-layer-for-current-models` and `keep-each-agent-conversation-append-only`. Start group 1 when the branch holds the code of both changes. That code holds the effort on the provider configuration, `continueAgent`, the tool mask, and `answerUnansweredToolCalls`.

A database test uses Postgres. Give it `CORTEX_TEST_PG_URL`, or run it with `bun run test:full`, as the Testing section of `CLAUDE.md` describes.

## 1. The round sink of the loop

- [x] 1.1 In `src/loop/run-agent.ts`, export `interface AgentRound { readonly messages: readonly LoopMessage[] }`. The doc comment says that a round holds the messages that the loop appended after the last call of the sink.
- [x] 1.2 Add `readonly onRound?: (round: AgentRound) => Promise<void>` to `RunAgentOptions`. The doc comment gives the three call points of 1.4 to 1.6. It also says that a durable loop passes no sink, because DBOS replays the body.
- [x] 1.3 In the run state that the segments share, keep `givenCount`, with the start value `initial.length`. Add `giveRound()`, which calls the sink with `messages.slice(givenCount)` when that slice holds a message. Then it sets `givenCount`.
- [x] 1.4 Await `giveRound()` before each model request of each segment, the wrap-up requests included. Expected result: the sink holds each tool message before the next request.
- [x] 1.5 At each exit of the task segment, of the wrap-up, and of `continueAgent`, await `giveRound()`. Do it after the not-run answers and after the interruption marker.
- [x] 1.6 Wrap the body of the run in a `catch` that runs only when the run has a sink. It calls `answerUnansweredToolCalls(messages, givenCount)`, awaits `giveRound()`, and throws the first error again.
- [x] 1.7 Set a flag when the sink rejects. The `catch` of 1.6 throws such an error again at once, with no call of the sink. When the last `giveRound()` of the `catch` rejects, throw the first error.
- [x] 1.8 Keep `roundStart`, the length of `messages` when the loop sends a model request. Make `markLastLoopAssistant` mark only a message at or after `roundStart`.
- [x] 1.9 Expected result of 1.8: a partial with content carries the marker, and an abort with no partial marks no message. Write the doc comment of `markLastLoopAssistant` and the comments at its call sites again.
- [x] 1.10 In `src/loop/continue-agent.ts`, give `opts.onRound` to the segment. Expected result: the request text of the continuation rides its first round.
- [x] 1.11 In `src/index.ts`, export the type `AgentRound` beside `RunAgentOptions`.
- [x] 1.12 In `src/loop/run-agent.test.ts`, add `describe("runAgent — round sink")` with these tests:
  - The initial messages and then each round equal `result.messages`.
  - The fake provider reads the record of the sink at each call, and each earlier reply and tool message is there.
  - No round is empty.
  - A truncated prose reply gives a round with the reply and the steer.
  - The wrap-up request text rides the round before the first wrap-up request.
  - A fatal tool throw gives a last round with the assistant message and a not-run result. The run throws the same error.
  - A failed first request gives no round.
  - A sink that rejects gets no second call, and the run throws its rejection.
  - A run with a sink and a run without one, over one model script, return the same messages and the same finish.
- [x] 1.13 In `describe("runAgent — aborted terminal path")` and `describe("runAgent — aborted wrap-up path")`, change each test that expects the marker on a tool-calling message. Expected result: that message carries no marker.
- [x] 1.14 In `describe("continueAgent")`, add a test with a sink. Expected result: the first round holds the request text, and the next round holds the reply.
- [x] 1.15 Run `tsc -p tsconfig.json`. Run `bun test src/loop`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 2. The context records

- [x] 2.1 In `src/memory/ai-sdk-message-storage.ts`, add `CONTEXT_KIND_KEY = "contextKind"` and `CONTEXT_HASH_KEY = "contextHash"`. Export `type ContextKind = "analysis-context" | "run-activity" | "working-memory"`.
- [x] 2.2 Export `contextRecordMessage(kind: ContextKind, text: string): ModelMessage`. It gives a `user` message with the text. Its `providerOptions.cortex` holds `synthetic: true`, the kind, and the SHA-256 hex hash of the text, and no `syntheticRecord`.
- [x] 2.3 Export `contextRecordOf(message: ModelMessage): { kind: ContextKind; hash: string } | undefined`. It gives `undefined` for a message without the two keys.
- [x] 2.4 In `src/app/run-activity.ts`, remove `compactAge`, the `started` field of each row, and the `nowMs` parameter of `renderRunActivity`. Write the module header again: the render holds no time of the call.
- [x] 2.5 In `src/app/message-assembly.ts`, add `contextRecordsFor(args, history)`. It builds the text of each kind, in the order analysis context, run activity, and working memory.
- [x] 2.6 The texts are `[Analysis Context]` and the context, the Run Activity render, and `[Working Memory]` and the render. An empty render gives `[Working Memory]` and the line `The working memory is empty.`
- [x] 2.7 A null or empty analysis context gives no record. A `report` thread gives no working-memory record.
- [x] 2.8 For each kind, find the latest message of that kind in `history` with `contextRecordOf`. Keep the new record only when no message of that kind exists, or when the hash differs.
- [x] 2.9 In `assembleMessages`, give `messages` as `[...history, userMessage, ...contextRecords]`. Add `readonly contextRecords: readonly ModelMessage[]` to `AssembledMessages`.
- [x] 2.10 Write the module header of `src/app/message-assembly.ts` again. Remove the text on the tail and on the store of the user message alone. Name the records and the hash rule.
- [x] 2.11 In `src/app/chat-turn.ts`, carry `contextRecords` on the `ok` result of `prepareChatTurn`.
- [x] 2.12 In `src/memory/ai-sdk-message-storage.test.ts`, add tests. Expected result: a record round-trips through `envelopeMessage`, `isSyntheticUserMessage` is true, `isSyntheticRecordMessage` is false, and a plain message gives `undefined`.
- [x] 2.13 In `src/app/run-activity.test.ts`, change the tests of the age. Expected result: no row names an age, and two renders of one activity at different times are byte-identical.
- [x] 2.14 In `src/app/message-assembly.test.ts`, change the tests that expect the old tail order. Then add these tests:
  - A history with no record gives each kind after the user message, in order.
  - A history that holds the same records gives no record.
  - A changed working memory gives one working-memory record.
  - Only the latest record of a kind counts, thus an older copy with the new hash does not stop a new record.
  - A `report` thread gives no working-memory record.
  - An empty working memory gives the empty-state text.
  - A null analysis context gives no record.
- [x] 2.15 In `src/app/chat-turn.test.ts`, change the tests that read the tail order. Expected result: the messages end with the user message and then the records.
- [x] 2.16 In `src/providers/configured-provider.barrel.test.ts`, add a wire test. Expected result: an `anthropic` body with a context record carries its text and no key of the `cortex` namespace.
- [x] 2.17 Run `tsc -p tsconfig.json`. Run `bun test src/memory/ai-sdk-message-storage.test.ts src/app/run-activity.test.ts src/app/message-assembly.test.ts src/providers/configured-provider.barrel.test.ts`. Run `bun test src/app/chat-turn.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 3. The turn record and the store writes

- [x] 3.1 In `src/state/init.ts`, add the table `cortex_thread_turns` of the design, after the table `messages`. Write a comment block for its columns, the same as the block of `messages`.
- [x] 3.2 In that block, say that the table holds the state of a turn and no message. Say that `messages.reported_usage` and `messages.turn_duration_ms` hold the figures of the older turns.
- [x] 3.3 In `src/memory/thread-history.ts`, remove `turnUsage` and `turnDurationMs` from `ConversationTurn`. Remove the write of the two columns. Keep their read in `readTurns`.
- [x] 3.4 Move the insert of one group out of `appendTurn` into `insertGroup(client, threadId, startSeq, group)`. Expected result: `appendTurn` and `writeTurn` store one group the same way.
- [x] 3.5 Export `type TurnStatus = "open" | "done" | "aborted" | "failed"`. Export `TurnClose` with `status: Exclude<TurnStatus, "open">`, `reason?`, `turnUsage?`, `turnDurationMs?`, and `note?: ConversationTurn`.
- [x] 3.6 Export `TurnWrite` as a union of two shapes. One shape holds `opening`, and the other holds `startSeq`. Both hold `rounds` and an optional `close`. Export `TurnWriteResult` with `startSeq`.
- [x] 3.7 Add `writeTurn(threadId, write): ResultAsync<TurnWriteResult, DbError>` to `ThreadHistory`. Do the write in one `withTransaction`, under the advisory lock of `appendTurn`.
- [x] 3.8 In `writeTurn`, insert the opening group, and then the turn record with the status `open`, keyed by the `seq` of the first opening row. Then insert each round group, and then the note group.
- [x] 3.9 When `close` is present, update the record where the status is `open`. Set the status, the reason, `closed_at`, the rollup under `hasReportedUsage`, and the duration.
- [x] 3.10 In `writeTurn`, touch `cortex_analysis_threads.updated_at` one time, with the savepoint of `appendTurn`.
- [x] 3.11 In `retractLastTurn`, delete each row of `cortex_thread_turns` with `start_seq >= boundary`, in the same transaction.
- [x] 3.12 Write the doc comment of `retractLastTurn` again. When the last turn goes, each earlier prefix stays byte-identical. A later request never sees a changed earlier record, and only the last turn can go.
- [x] 3.13 Export `StoredTurnRecord` with `status`, `reason?`, `usage?`, and `durationMs?`. Add `readonly turn?: StoredTurnRecord` to `StoredMessage`.
- [x] 3.14 In `readTurns`, join `cortex_thread_turns` on the thread id and on `start_seq = messages.seq`. Set `turn` only on a row with a record. Set each member only when its column is not null.
- [x] 3.15 In `src/memory/thread-store.ts`, make `purgeThread` delete the rows of `cortex_thread_turns` of the subtree. Do it after the messages and before the thread rows.
- [x] 3.16 In `src/state/purge-analysis.ts`, make `deleteCortexRows` delete the rows of `cortex_thread_turns` through the thread rows, before the thread rows.
- [x] 3.17 In `src/memory/thread-history.test.ts`, add `describe("writeTurn")` with these tests:
  - An opening adds its rows and an `open` record, keyed by the `seq` of the user row.
  - A later write appends its rounds after the opening, and each round has its display envelope.
  - One write with the opening, two rounds, and the close lands each part, in order.
  - A close sets the status, the reason, the rollup, and the duration.
  - A rollup with no quantity stays absent, and a second close changes nothing.
  - A failed write leaves no row and no record.
  - The retract removes the rows and the record of the last turn, and the rows of the earlier turn stay byte-identical.
  - `loadAll` gives the record on the user row only, and `appendTurn` of a host record adds no record.
- [x] 3.18 In the same file, remove the tests of the rollup and the duration that `appendTurn` wrote. Keep a test that an old row with the two columns reads back with its figures.
- [x] 3.19 In `src/memory/thread-store.test.ts` and `src/state/purge-analysis.test.ts`, add one test each. Expected result: the purge removes the turn records.
- [x] 3.20 Run `tsc -p tsconfig.json`. Run `bun test src/memory/thread-history.test.ts src/memory/thread-store.test.ts src/state/purge-analysis.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 4. The display of each round

- [x] 4.1 In `src/memory/conversation-display-recorder.ts`, make the user id and the assistant id one time, when the recorder is made. Use the option value when it is given.
- [x] 4.2 Add `takeOpening(): ConversationUIMessage[]` to `ConversationDisplayRecorder`. It gives the user message of the turn, with the id of 4.1.
- [x] 4.3 Add `takeRound(messages: readonly ModelMessage[]): ConversationUIMessage[]`. It gives one assistant message with the parts that the recorder got after the last take, under the id of 4.1. It gives an empty array when no part exists.
- [x] 4.4 In `takeRound`, when the parts hold no text, add the text of the assistant messages of the round. Set `state: "done"` on each text part. Mark each `data-ask` part with the status `pending` as `aborted`.
- [x] 4.5 After a take, clear the parts and the index of the reconciling parts. Thus a later update of a part lands in the next round, and the replay replaces the earlier copy.
- [x] 4.6 Keep `finish` with no change of its behavior. Its doc comment says that `runChatTurn` uses `takeOpening` and `takeRound`.
- [x] 4.7 In `src/memory/conversation-display-replay.ts`, merge a stored assistant message into the message before it when the two share an id. Append the parts in order. A reconciling part replaces its earlier copy with the same type and id.
- [x] 4.8 In the same function, fold the `turn` of a user row onto the last assistant message of that turn. Set `usage`, `durationMs`, and `interrupted: true` for the status `aborted`. The turn ends at the next genuine user row.
- [x] 4.9 Keep the fold of the row figures for an older turn. Write the module header again for the merge and the fold.
- [x] 4.10 In `src/memory/conversation-display-recorder.test.ts`, add these tests:
  - `takeOpening` gives the user message.
  - Two takes give the parts of each round under one assistant id.
  - A round with no streamed text takes the text of its assistant message.
  - A pending approval becomes `aborted` at the take.
  - A round with no part gives no message.
- [x] 4.11 In `src/memory/conversation-display-replay.unit.test.ts`, add these tests:
  - Two rounds with one id give one assistant message, with the parts in order.
  - A reconciling part in a later round replaces its earlier copy.
  - A `turn` with the status `aborted` folds the rollup, the duration, and `interrupted`.
  - An older turn keeps the fold of its row figures.
  - A failure note stays a `system` message after the assistant message.
- [x] 4.12 Run `tsc -p tsconfig.json`. Run `bun test src/memory/conversation-display-recorder.test.ts src/memory/conversation-display-replay.unit.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 5. The chat turn

- [x] 5.1 In `src/providers/prompt-cache.ts`, export `CONVERSATION_PROMPT_CACHE: PromptCachePolicy = { ttl: "1h" }` beside `DEFAULT_PROMPT_CACHE`. The doc comment gives the reason: a person can reply 5 to 60 minutes later.
- [x] 5.2 In the same doc comment, say that only the root loop of a chat turn uses it. Each other loop keeps `DEFAULT_PROMPT_CACHE`, because its requests start less than 5 minutes apart.
- [x] 5.3 In `src/app/chat-turn.ts`, export `RunChatTurnDeps`: `PrepareChatTurnDeps` and `readonly agents: ThreadAgentResolver`.
- [x] 5.4 Export `RunChatTurnParams` with `analysisId`, `threadId`, `userInput`, `session`, `chat: (emit: EmitFn) => AgentChat`, `emit`, `signal`, and `usageRecorder`. Add the optional `ask`, `author`, `startedAtMs`, and `promptCache`.
- [x] 5.5 Export `ChatTurnOutcome`: `{ status: "done"; finish }`, `{ status: "aborted"; finish? }`, or `{ status: "failed"; reason; cause }`.
- [x] 5.6 Export `ChatTurnResult` with the kinds `prepare_failed`, `not_found`, `agent_unresolved`, and `ran`. `ran` carries `outcome`, `opened`, `storeError?`, `durationMs`, `turnUsage?`, and `fallbackText?`.
- [x] 5.7 Add `export async function runChatTurn(deps, params): Promise<ChatTurnResult>`. It calls `prepareChatTurn`, gives `prepare_failed` for a throw, and gives `not_found` unchanged. The function is an API boundary, thus its `catch` is permitted.
- [x] 5.8 Resolve the agent with `deps.agents.forThread(prepared.threadType)`. A refusal gives `agent_unresolved` with the thread type. Expected result: the turn wrote no row.
- [x] 5.9 Make the display recorder over `params.emit`, with `userText: params.userInput` and the call path of the session. Start the list of pending groups with the opening group.
- [x] 5.10 The opening group holds `userMessage` and `contextRecords`, the display of `takeOpening()`, and the author.
- [x] 5.11 Add `flush(close?)`. It calls `writeTurn` with the pending groups, `startSeq` when known, and `close`. It does nothing when the list is empty and no close is given.
- [x] 5.12 On `ok`, `flush` clears the list and keeps `startSeq`. On `err`, it keeps the list and the error, and it logs a warn with the thread id.
- [x] 5.13 Await `flush()` before `runAgent`. Run `runAgent` with `chat(recorder.emit)`, `recorder.emit`, the signal, `passthroughStep`, the usage recorder, the logger, and the bound `ask`.
- [x] 5.14 Give the root loop `promptCache: params.promptCache ?? CONVERSATION_PROMPT_CACHE`. Give no `reasoning`, thus the effort comes from the provider configuration.
- [x] 5.15 Give `runAgent` an `onRound` that adds the group of the round, with the display of `takeRound(round.messages)`. Then it awaits `flush()`.
- [x] 5.16 Select the outcome by the rules of the spec. For a throw, read `signal.aborted` and the error name `AbortError`, the same as `cli/src/modules/harness/turn.ts` lines 403-407 do now.
- [x] 5.17 Add `failureReasonOf(err: unknown): string`. A `suspend` error gives the reason of `suspensionOfFailure`. Find a `ProviderError` on the `ResultError` value and on the cause chain.
- [x] 5.18 In `failureReasonOf`, an `auth` error gives `The model endpoint refused the credential.` A different provider error gives `The model request failed.` A different error gives `The turn stopped on an internal error.`
- [x] 5.19 Add `failureNote(reason: string): string`. Its lines are `[Turn Failed]`, `The turn stopped before it finished. Reason: <reason>`, and `The rounds above this note ran, and their results are stored.`
- [x] 5.20 Close the turn with `flush(close)`. The close holds the status, the reason, the `turnUsage` of the finish, and the duration from `params.startedAtMs`, or from the call time.
- [x] 5.21 For `failed`, add the note `conversationRecordTurn(failureNote(reason))` to the close.
- [x] 5.22 Give `ran` with the outcome, `opened`, `storeError`, the duration, the turn usage, and `fallbackText`. `opened` is true when a write gave `startSeq`. `storeError` is the kept error when groups stayed pending.
- [x] 5.23 Write the module header of `src/app/chat-turn.ts` again. A turn is `runChatTurn`, and `prepareChatTurn` is its first step.
- [x] 5.24 In `src/index.ts`, export `runChatTurn` and the types of 5.3 to 5.6. Export the types `TurnWrite`, `TurnWriteResult`, `TurnClose`, `TurnStatus`, and `StoredTurnRecord`, because a fake of `ThreadHistory` names them.
- [x] 5.25 In `src/index.ts`, export `CONVERSATION_PROMPT_CACHE` beside `DEFAULT_PROMPT_CACHE`. Write the comment above that export again: the root loop of a chat turn uses 1 hour, and each other loop uses 5 minutes.
- [x] 5.26 Write the comment of the conversation-turn block in `src/index.ts` again. A host calls `runChatTurn`, and `appendTurn` stays for a host record.
- [x] 5.27 In `src/app/chat-turn.test.ts`, add `describe("runChatTurn")` with a fake provider and Postgres. Add these tests:
  - A clean turn stores the opening, each round, and a `done` record with the rollup and the duration.
  - `loadAll` and `storedMessagesToCortex` give one user message and one assistant message for the turn.
  - An `auth` error on the third request keeps two rounds, adds the note, and closes `failed` with the credential reason.
  - The next turn sends a prefix that starts with each stored row of the failed turn, byte-identical.
  - A `suspend` error closes `failed` with the reason `payment_required`.
  - An abort before any output stores the opening and closes `aborted`.
  - A tool that throws an `AbortError` under a live signal gives `failed`, and the thread holds the assistant message with a not-run result.
  - An unresolved agent writes no row and no record.
  - A second turn with no change adds no context record.
- [x] 5.28 In the same file, add tests of the cache policy. Expected result: the root loop sends 1-hour markers, a host policy of 5 minutes wins, and a sub-agent loop inside the turn sends 5-minute markers.
- [x] 5.29 In the same file, give a turn a pool whose client fails the insert of the first round one time. Expected result: the second write stores both rounds in order, and `storeError` is absent.
- [x] 5.30 Run `tsc -p tsconfig.json`. Run `bun test src/app/chat-turn.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 6. The CLI

- [x] 6.1 In `cli/src/modules/harness/turn.ts`, import the `runChatTurn` of the harness as `runHarnessChatTurn`. Make the `runChatTurn` of the CLI call it with the values of the surface.
- [x] 6.2 Give the harness the deps `pool`, `agents`, `logger: harnessLogger("harness")`, and `provenance: provenanceSeam()`. These are the values that the prepare step gets now.
- [x] 6.3 Remove `history` from `RunChatTurnArgs`. Change `ChatTurnSeams` to `turn` and `readAuthor`. Set `realTurnSeams` to `{ turn: runHarnessChatTurn, readAuthor: currentUserEmail }`.
- [x] 6.4 Map `prepare_failed`, `not_found`, and `agent_unresolved` to the current kinds `prepare_failed`, `thread_gone`, and `agent_unresolved`.
- [x] 6.5 Map `ran` by its outcome. `done` with the finish reason `content-filter` gives `filtered`, and a different `done` gives `ok`. `aborted` gives `aborted`, and `failed` gives `failed` with its cause.
- [x] 6.6 Add `readonly opened: boolean` to the four kinds that ran. Carry `storeError` as `appendError`, and carry `turnUsage`, `fallbackText`, and `rawFinishReason`.
- [x] 6.7 Keep `enterChatTurn`, the read of the author at the top, and each log record of the kinds. Give the harness `startedAtMs: turnStartedAt`, and give no `promptCache`, thus the root loop uses 1 hour.
- [x] 6.8 Write the doc comments of `TurnOutcome`, `RunChatTurnArgs`, and `runChatTurn` again. The harness stores the opening, each round, and the outcome, and a throw keeps the stored rounds.
- [x] 6.9 In `healTailOrphan`, remove the tail turn when it holds no row with the role `assistant`. Expected result: a tail of a user message and its context records goes, and an answered turn stays.
- [x] 6.10 In `cli/src/tui/hooks/conversation.ts`, make `turnAppendLanded` give `outcome.opened` for the four kinds that ran. Remove `history` from the call of `runChatTurn`.
- [x] 6.11 In `cli/src/modules/harness/dev/chat.ts`, remove the `history` argument of `runChatTurn`. Write the header comment again for the new sequence.
- [x] 6.12 In `cli/src/tui/hooks/thread_write.ts`, write the header comment again. The writes of a turn land inside `runChatTurn`, from the opening to the close.
- [x] 6.13 In `cli/src/modules/harness/turn.test.ts`, replace the fakes of `prepare` and `run` with a fake `turn`. Add a test of each map of 6.4 and 6.5, of `opened`, and of the author.
- [x] 6.14 In the same file, add a test. Expected result: `healTailOrphan` removes a tail of a user message and two context records.
- [x] 6.15 Add `writeTurn` to each fake `ThreadHistory`, in `turn.test.ts`, `usage_ledger.test.ts`, and `agent_switch.test.ts` of `cli/src/modules/harness/`.
- [x] 6.16 Add `opened: true` to each fake `TurnOutcome` of a kind that ran. The fakes are in `conversation.test.ts`, `conversation.render.test.tsx`, `conversation.usage_recorder.test.ts`, and `run_completion.test.ts` of `cli/src/tui/hooks/`.
- [x] 6.17 Do the same in `cli/src/tui/hooks/conversation.interrupt_retract.test.ts` and `cli/src/tui/plan_steps_command.test.tsx`. Expected result: each test that passed before still passes.
- [x] 6.18 In `cli/src/tui/hooks/conversation.interrupt_retract.test.ts`, add a test. Expected result: the retract skips the durable step when `opened` is false, and it runs the step when `opened` is true.
- [x] 6.19 In `cli/`, run `bun run harness:local`. Run `tsc -p tsconfig.json`. Run `bun test src/modules/harness src/tui/hooks src/tui/plan_steps_command.test.tsx`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.
- [x] 6.20 In `cli/`, run `openspec validate adopt-the-harness-chat-turn --strict`. Mark the tasks of that change.

## 7. Documents and final checks

- [x] 7.1 In `CONTEXT.md`, section "Memory", write the item "Thread history" again. Name `runChatTurn`, the append of each round, the turn record with its outcome, and the merge on read.
- [x] 7.2 In the same section, write the item "Working memory" again. The render is a context record after the user message, and a turn stores it only when it changed.
- [x] 7.3 In `CONTEXT.md`, section "Loop primitives", add `onRound` to the item "The loop". In section "Application service layer", add `runChatTurn` to the members.
- [x] 7.4 In `CLAUDE.md`, section "Key Components", write the item "Chat turn" again. A turn is `runChatTurn`, and the host gives only its transport values.
- [x] 7.5 In `README.md`, write the sentence on the chat turn again (line 99). A turn is `runChatTurn`.
- [x] 7.6 Write each changed sentence of 7.1 to 7.5 in STE. Run `bun ../.claude/hooks/ste-check.ts --file` on each file, and fix each hard finding in the changed text. Do not format a markdown file.
- [x] 7.7 Run `grep -rnE 'prepareChatTurn.{0,30}runAgent.{0,30}appendTurn' src README.md CONTEXT.md CLAUDE.md ../cli/src`. Expected result: no match.
- [x] 7.8 Run `tsc -p tsconfig.json`. Expected result: no error.
- [x] 7.9 Run `bun test`. Expected result: each unit test passes. A database suite uses Postgres.
- [x] 7.10 Run `bun run lint`. Expected result: no error. Run `bun run format:file` on each file under `src/` that this change changed.
- [x] 7.11 Run `openspec validate save-each-chat-round-and-add-context-on-change --strict` in `harness/`. Expected result: the change is valid.
- [x] 7.12 In `cli/`, run `bun run harness:local`, `tsc -p tsconfig.json`, `bun test`, and `bun run lint`. Expected result: no error and no failed test.
