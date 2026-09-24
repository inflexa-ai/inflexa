# Tasks

Each path is relative to `harness/`. A path that starts with `cli/` is relative to the root of the repository.

This change builds on `update-the-provider-layer-for-current-models`, `keep-each-agent-conversation-append-only`, and `save-each-chat-round-and-add-context-on-change`. Start group 1 when the branch holds the code of the three changes. That code holds `continueAgent`, the tool mask, `onRound`, `runChatTurn`, `takeRound`, and `contextRecordsFor`.

A database test uses Postgres. Give it `CORTEX_TEST_PG_URL`, or run it with `bun run test:full`, as the Testing section of `CLAUDE.md` describes.

Group 7 is the work of the CLI change `render-the-chat-compaction` in `cli/openspec`. Do the CLI work here, thus the two task lists cannot differ.

## 1. The marks of a compaction

- [x] 1.1 In `src/memory/ai-sdk-message-storage.ts`, add `COMPACTION_EXCHANGE_KEY = "compactionExchange"` and `COMPACTION_MARKER_KEY = "compactionMarker"`.
- [x] 1.2 Export `type CompactionMarker`. The `summary` arm holds `id`, `tokensBefore`, `tokensAfter`, and `durationMs`. The `drop` arm holds the same fields and `keptTurns`.
- [x] 1.3 Export `markCompactionExchange(message: ModelMessage, id: string): ModelMessage`. It gives a copy whose harness namespace holds the id. Expected result: each other namespace stays, the `anthropic` signatures included.
- [x] 1.4 Export `compactionExchangeOf(message: ModelMessage): string | undefined`. A message without the key gives `undefined`.
- [x] 1.5 Export `summaryMarkerMessage(summary: string, marker: CompactionMarker): ModelMessage`. It gives a `user` message with the text `[Conversation Summary]`, a new line, and the summary.
- [x] 1.6 The harness namespace of that message holds `synthetic: true` and the marker. It holds no `syntheticRecord`.
- [x] 1.7 Export `dropMarkerMessage(marker: CompactionMarker): ModelMessage`. It gives a `user` message with the text `[Compaction Failed]`, `synthetic: true`, and the marker.
- [x] 1.8 Export `compactionMarkerOf(message: ModelMessage): CompactionMarker | undefined`. A message without the key gives `undefined`.
- [x] 1.9 Write the doc comment of each export. Say that the view rule reads the marks, and that no provider reads the harness namespace.
- [x] 1.10 In `src/memory/ai-sdk-message-storage.test.ts`, add these tests:
  - A summary marker and a drop marker round-trip through `envelopeMessage` and `parseStoredMessageEnvelope`.
  - `isSyntheticUserMessage` is true for a marker, and `isSyntheticRecordMessage` is false.
  - A marked assistant message keeps its `anthropic` signature.
  - A plain message gives no marker and no exchange id.
- [x] 1.11 In `src/providers/configured-provider.barrel.test.ts`, add a wire test. Expected result: an `anthropic` body with a marker and an exchange message holds no key of the `cortex` namespace.
- [x] 1.12 Run `tsc -p tsconfig.json`. Run `bun test src/memory/ai-sdk-message-storage.test.ts src/providers/configured-provider.barrel.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 2. The view rule

- [x] 2.1 Make `src/memory/conversation-view.ts`. Move `isGenuineUserStart` and `groupTurns` from `src/memory/thread-history.ts` into it, and export the two functions.
- [x] 2.2 In `src/memory/thread-history.ts`, import the two functions. Keep `GENUINE_USER_START_SQL`, and make its comment name the new home of its twin predicate.
- [x] 2.3 Export `interface ConversationViewOptions { readonly keepFirstTurn?: boolean }`.
- [x] 2.4 Export `interface ConversationView { readonly messages: ModelMessage[]; readonly sources: number[] }`. `sources[i]` is the index of the input message that gives `messages[i]`.
- [x] 2.5 Export `conversationView(messages, options): ConversationView`. Do the rule of the design: the head, the skip of an exchange message, the summary front, the drop, and the body.
- [x] 2.6 The head ends at the next genuine user start, or at the first message that carries a marker or an exchange mark.
- [x] 2.7 Export `withoutReasoning(message: ModelMessage): ModelMessage | undefined`. It gives an assistant message with no `reasoning` part, and `undefined` when no part is left. It gives each other message unchanged.
- [x] 2.8 Export `viewTokens(messages: readonly ModelMessage[]): number`. It gives the sum of `countTokens(message.content)`.
- [x] 2.9 Export `keptTurnsForDrop(messages, options, budget): number`. It walks the turns of the body of the current view, from the newest turn.
- [x] 2.10 The walk keeps the newest turn. It adds each older turn while `viewTokens` of the view stays within `budget`. Expected result: the count of the kept turns.
- [x] 2.11 Write the module header. It gives the rule, and it says that the loop and the reader call the same function.
- [x] 2.12 In the new `src/memory/conversation-view.test.ts`, add these tests:
  - A list with no marker gives each message, and `sources` gives each index.
  - Only the latest summary marker counts.
  - No exchange message joins the view, also when no marker comes after the exchange.
  - `keepFirstTurn` keeps the seed in front of the summary marker.
  - A drop keeps the summary in front, and then the last kept turns.
  - A kept message loses its reasoning, and a message after the drop keeps its reasoning.
  - An assistant message with only a reasoning part leaves the view of a drop.
  - The view of a view is byte-identical to the view.
  - `keptTurnsForDrop` keeps the newest turn when that turn alone exceeds the budget.
- [x] 2.13 Run `tsc -p tsconfig.json`. Run `bun test src/memory/conversation-view.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 3. The reader

- [x] 3.1 In `src/memory/thread-history.ts`, change the signature to `loadRecent(threadId: string, options?: LoadRecentOptions)`. It gives `conversationView(rows, options).messages`.
- [x] 3.2 Remove the budget walk, the block snap, `keepsFirstTurn`, and `EVICTION_BLOCK_TURNS`. Expected result: `grep -rn EVICTION_BLOCK_TURNS src` finds nothing.
- [x] 3.3 Keep the two histograms. `turnsEvicted` records the count of the turns whose messages the view holds none of. Read `sources` for the count.
- [x] 3.4 The attribute `eviction` is true when that count is above 0.
- [x] 3.5 Write these doc comments again: `ThreadHistory.loadRecent`, `LoadRecentOptions`, the module header, and the descriptions of the two histograms. Say that stored markers decide the view.
- [x] 3.6 In `src/app/message-assembly.ts`, remove `DEFAULT_HISTORY_TOKEN_BUDGET` and `AssembleMessagesArgs.tokenBudget`. Call `loadRecent(threadId, { keepFirstTurn: threadType === "report" })`.
- [x] 3.7 Write the module header of `src/app/message-assembly.ts` again. The history is the view of the latest marker, and the root loop compacts at its budget.
- [x] 3.8 In `src/memory/count-tokens.ts`, write the module header again. The `tokens` count is the estimate of the loop, and `loadRecent` has no budget.
- [x] 3.9 In `src/providers/prompt-cache.ts`, write the paragraph on `loadRecent` again. A compaction moves the start of the view one time, and the prefix holds still between two compactions.
- [x] 3.10 In `src/memory/thread-history.test.ts` and `src/memory/thread-store.test.ts`, remove the budget argument of each call of `loadRecent`.
- [x] 3.11 In `src/memory/thread-history.test.ts`, replace the blocks "loadRecent token windowing", "loadRecent prefix stability", "loadRecent retained first turn", and "loadRecent boundary snapping". Add these tests:
  - A thread with no marker gives each row.
  - A stored summary marker starts the view, and the stored exchange is not in it.
  - A report thread with `keepFirstTurn` gives the seed and then the summary marker.
  - A stored drop marker gives the summary, then the kept turns without reasoning, then the later rows.
  - A retract of the last turn removes its marker, and the view goes back to the earlier marker.
- [x] 3.12 Change the block "loadRecent overflow metric". Expected result: a thread with a marker in its sixth turn records 5 left-out turns and `eviction: true`.
- [x] 3.13 Change the block "loadRecent ignores the stored rollup". Expected result: the view is the same with and without a rollup on each row.
- [x] 3.14 In `src/app/message-assembly.test.ts`, change each fake of `loadRecent` to the new signature. Expected result: a fake reads `keepFirstTurn` from its second argument.
- [x] 3.15 Run `tsc -p tsconfig.json`. Run `bun test src/app/message-assembly.test.ts`. Run `bun test src/memory/thread-history.test.ts src/memory/thread-store.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 4. The data part and the divider vocabulary

- [x] 4.1 In `src/contracts/chat-parts.ts`, add `interface CompactionPart` with the fields of the design. Add it to `CortexChatPart`, and name it in the header comment of the module.
- [x] 4.2 The doc comment of `CompactionPart` says: one id for each compaction, `running` and then `done` or `failed`, and a divider after a reload.
- [x] 4.3 In `src/contracts/schemas/chat-parts.ts`, add `CompactionPartSchema`, and add it to `CortexChatPartSchema`. `tokensBefore`, `tokensAfter`, and `durationMs` are non-negative integers.
- [x] 4.4 In `src/contracts/part-registry.ts`, add `"data-compaction": { emitter: "conversation", consumer: "conversation", transient: true, reconciling: true }`.
- [x] 4.5 In `src/memory/conversation-display-storage.ts`, add `compaction: Payload<CompactionPart>` to `ConversationUIData`. Add `compaction: CompactionPartSchema.omit({ type: true })` to `dataSchemas`.
- [x] 4.6 In `src/index.ts`, export the type `CompactionPart` beside the other chat parts.
- [x] 4.7 In `src/contracts/chat-parts.test.ts`, add tests. Expected result: the schema accepts a `running` part and a `done` part, and it refuses an unknown status.
- [x] 4.8 In `src/memory/conversation-display-storage.test.ts`, add a test. Expected result: a `system` message with a `data-compaction` part round-trips, and `conversationUIToCortexMessages` gives the part.
- [x] 4.9 In `src/memory/conversation-display-recorder.test.ts`, add a test. Expected result: an emitted `data-compaction` part does not join the assistant message.
- [x] 4.10 Run `tsc -p tsconfig.json`. Run `bun test src/contracts/chat-parts.test.ts src/memory/conversation-display-storage.test.ts src/memory/conversation-display-recorder.test.ts`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 5. The compaction of the loop

- [ ] 5.1 Make `src/loop/compaction.ts`. Export `interface CompactionPolicy` with the fields of the design, and `COMPACTION_MAX_REQUESTS = 4`.
- [ ] 5.2 In `src/loop/run-agent.ts`, add `readonly compaction?: CompactionPolicy` to `RunAgentOptions`. The doc comment gives the check points, and it says that a durable loop passes no policy.
- [ ] 5.3 Add `readonly checksBudget?: boolean` to `LoopSegment`. `runAgentLoop` sets it on the task segment only. Expected result: the wrap-up and each continuation never compact.
- [ ] 5.4 In `src/loop/continue-agent.ts`, add `readonly endOnRequestRefusal?: boolean` to `ContinuationRequest`. Give it to the segment as `LoopSegment.endsOnRequestRefusal`.
- [ ] 5.5 In `openLoop`, when the segment has `endsOnRequestRefusal`, run the model step with `callStep`, not `resultStep`. The step gives the `Result` as its value.
- [ ] 5.6 A `provider` error whose `extractStatus` is `400` or `413` ends the segment with the finish reason `error`. Expected result: no throw, and no message joins the transcript.
  - Add `readonly refusal?: { status: number; message: string }` to `ContinuationResult`. It keeps the status and the `message` of that error.
- [ ] 5.7 Each other `err` of that step goes through `unwrapOrThrow`, the same as in `resultStep`. Expected result: an `auth`, a `suspend`, or a transient error throws.
- [ ] 5.8 In `openLoop`, add `viewOf()`. With a policy, it gives `conversationView(messages, { keepFirstTurn }).messages`. Without a policy, it gives `messages`.
- [ ] 5.9 `callModel` sends `withPromptCacheBreakpoint(viewOf(), promptCache)`. Expected result: a run with no policy sends the same request bytes as before.
- [ ] 5.10 Keep the flag `continuesTruncation`. Set it when the loop appends the steer of a truncated prose reply, and clear it after the next request.
- [ ] 5.11 Keep the flag `compactionStopped` and the count `compactions`. The count gives `<n>` of the namespace `compaction-<n>`.
- [ ] 5.12 Before each request of a segment with `checksBudget`, after the round sink got the round, estimate `viewTokens(viewOf())`.
- [ ] 5.13 When the estimate exceeds `policy.budget`, and neither flag stops it, await `compact(estimate)`.
- [ ] 5.14 In `compact`, emit a `data-compaction` part with `running`, a new id, and `tokensBefore`. Use the `source` of the run.
- [ ] 5.15 Run the exchange with `continueAgent(agent, viewOf(), request, session, options)`. The request holds the text and the mask of the policy, the cap, and `endOnRequestRefusal: true`.
  - The import makes a cycle between `run-agent.ts` and `continue-agent.ts`. Each module uses the other only inside a function, thus the cycle is safe.
- [ ] 5.16 The request also holds the namespace `compaction-<n>` and the accounting id `<agent.id>-compaction`.
- [ ] 5.17 The options are `opts` with `provider: policy.provider` and the turn accumulator of the run. They hold no `onRound` and no `compaction`.
- [ ] 5.18 Put the exchange in a `try` block with a `finally` block and no `catch`. For a throw, the `finally` block emits `failed`, and the throw passes through.
- [ ] 5.19 Mark each message of the exchange with `markCompactionExchange`. Append the messages to `messages`, and give them to the sink as one round.
- [ ] 5.20 For the finish reason `aborted`, emit `failed`. Then end the run the same way as an aborted reply of the task. Expected result: the finish reason `aborted`, and a transcript with the exchange and no marker.
- [ ] 5.21 For a summary, make the marker with `summaryMarkerMessage`. For an exchange with no summary, make it with `dropMarkerMessage` and `keptTurnsForDrop(messages, options, policy.budget)`.
- [ ] 5.22 The figures of a marker do not change the view. Thus compute the new view as `conversationView` of `messages` and the marker.
- [ ] 5.23 Call `policy.recordsAfter` with the new view. Estimate `tokensAfter` over the new view and the records, and measure `durationMs`.
- [ ] 5.24 Make the marker again with `tokensAfter` and `durationMs`. Append it and then the records to `messages`, and give the two to the sink as one round.
- [ ] 5.25 Emit `done` for a summary, or `failed` for a drop, with `tokensAfter` and `durationMs`.
- [ ] 5.26 Log at `info` for a summary and at `warn` for a drop. Give the id, the two estimates, the duration, and `keptTurns` as fields.
  - A drop for a refusal also gives `status` and `providerError`, the `message` of the error, as fields. Expected result: a false drop is visible in the log.
- [ ] 5.27 Set `compactionStopped` after a drop, or when the new estimate still exceeds the budget.
- [ ] 5.28 In `src/index.ts`, export the types `CompactionPolicy` and `ToolMask` beside `RunAgentOptions`.
- [ ] 5.29 In `src/loop/run-agent.test.ts`, add `describe("runAgent — compaction")` with these tests:
  - A run with no policy sends its transcript, and no compaction runs.
  - A view within the budget runs no exchange.
  - A round that passes the budget runs the exchange before the next request.
  - The exchange request carries the tools of the run, and its messages start with the view, byte-identical.
  - The request after a summary holds the marker and the records, and no message of the exchange.
  - A second compaction starts from the first summary marker.
  - `keepFirstTurn` keeps the first turn in front of the marker.
  - The mask refuses a tool outside it during the exchange.
- [ ] 5.30 In the same block, add these tests:
  - An exchange that calls a tool in each of its 4 replies ends with a drop marker.
  - A `400` refusal of the exchange gives a drop marker, and the run does not throw.
  - The `warn` of that drop carries the status `400` and the error text of the provider.
  - An `auth` error, a `suspend` error, and a transient error of the exchange throw, with no marker and the part `failed`.
  - A drop keeps the previous summary in front, and the kept reasoning is not sent.
  - No second compaction runs after a drop.
  - An abort during the exchange gives the finish reason `aborted`, no marker, and the part `failed`.
  - The sink gets the exchange round and then the marker round, and the rounds equal the result.
  - The part goes `running` and then `done`, under one id, with the source of the run.
  - The usage records of the exchange carry `<agent.id>-compaction`, and the turn total holds them.
  - A wrap-up request and a request after a truncated reply run no exchange.
- [ ] 5.31 Run `tsc -p tsconfig.json`. Run `bun test src/loop`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 6. The chat turn

- [ ] 6.1 Make `src/prompts/compaction.ts`. Export `MEMORY_COMPACTION_REQUEST` with the text of the design. Export `SUMMARY_COMPACTION_REQUEST`, the same text with no memory step.
- [ ] 6.2 In `src/app/chat-turn.ts`, export `DEFAULT_CONVERSATION_BUDGET = 150_000`. The doc comment says that the root loop compacts its view past this estimate.
- [ ] 6.3 Add `readonly conversationBudget?: number` to `RunChatTurnParams`.
- [ ] 6.4 In `runChatTurn`, make the policy of the root loop. `budget` is `params.conversationBudget ?? DEFAULT_CONVERSATION_BUDGET`.
- [ ] 6.5 `provider` is `params.chat` over an emit sink that drops each text delta. Expected result: the emit of the host gets no text delta of the exchange.
- [ ] 6.6 When the agent declares `update_working_memory`, give the mask `{ allow: ["update_working_memory"] }` and `MEMORY_COMPACTION_REQUEST`.
- [ ] 6.7 Else give the mask `"none"` and `SUMMARY_COMPACTION_REQUEST`. A `report` thread reads a frozen copy of working memory, thus its agent declares no such tool.
- [ ] 6.8 `keepFirstTurn` is `prepared.threadType === "report"`.
- [ ] 6.9 `recordsAfter(view)` reads the analysis context, the run activity, and the working memory again, the same as `prepareChatTurn`. It gives `contextRecordsFor(args, view)`.
- [ ] 6.10 Give the policy to the root `runAgent` only.
- [ ] 6.11 In `src/memory/conversation-display-recorder.ts`, make `takeRound` skip the text of each message with an exchange mark. Expected result: an exchange round with no part gives no message.
- [ ] 6.12 When the round holds a marker, `takeRound` gives the divider. It comes after the assistant message of the parts, when parts exist.
- [ ] 6.13 The divider is a `system` message with the id of the compaction and one `data-compaction` part. The part carries the figures of the marker.
- [ ] 6.14 The status of that part is `done` for a summary marker and `failed` for a drop marker.
- [ ] 6.15 After a marker round, `takeRound` makes a new assistant id for the later rounds of the turn. Expected result: no two messages of the replay share an id.
- [ ] 6.16 In `src/index.ts`, export `DEFAULT_CONVERSATION_BUDGET` beside `runChatTurn`.
- [ ] 6.17 In `src/memory/conversation-display-recorder.test.ts`, add these tests:
  - An exchange round gives no message.
  - A marker round gives the divider with the figures of the marker.
  - The text of an exchange never becomes the text of a round.
  - A round after a marker round carries a new assistant id.
- [ ] 6.18 In `src/memory/conversation-display-replay.unit.test.ts`, add these tests:
  - A divider between two rounds gives two assistant messages with the divider between them.
  - A divider of a drop carries `failed`.
- [ ] 6.19 In `src/app/chat-turn.test.ts`, add `describe("runChatTurn — compaction")` with a fake provider and Postgres. Add these tests:
  - A turn over `conversationBudget` stores the opening, a round, the marked exchange, the marker, the records, and the later rounds.
  - `loadAll` and `storedMessagesToCortex` give the divider between the two assistant messages of the turn, with two ids.
  - The next turn starts with the summary marker and its records, then the later rounds, then the new opening.
  - The emit of the host gets no text delta of the exchange.
  - The working-memory record after the marker holds a constraint that the exchange added.
  - A report turn starts with the seed and the summary marker, and it adds no working-memory record.
  - A retract of the last turn removes its exchange and its marker.
  - A turn under the default budget runs no exchange, and `DEFAULT_CONVERSATION_BUDGET` is `150_000`.
- [ ] 6.20 Run `tsc -p tsconfig.json`. Run `bun test src/memory/conversation-display-recorder.test.ts src/memory/conversation-display-replay.unit.test.ts`. Run `bun test src/app/chat-turn.test.ts` with Postgres. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.

## 7. The CLI

- [ ] 7.1 In `cli/src/types/session.ts`, add `CompactionPart` to the `Part` union. It holds `id`, `type: "compaction"`, `compactionId`, `status`, `tokensBefore`, `tokensAfter?`, and `durationMs?`.
- [ ] 7.2 The doc comment of `CompactionPart` says that the live adapter updates the part in place by `compactionId`, and that a reload gives the terminal status.
- [ ] 7.3 In `cli/src/modules/harness/chat_printer.ts`, add `readCompactionPart(data: unknown)`. It copies each field that it keeps. An unknown or missing status reads as `failed`, the safe terminal.
- [ ] 7.4 In `cli/src/tui/hooks/conversation.ts`, add a `data-compaction` case to `renderDataPart`. The first emission of an id appends a compaction part to the assistant message of the turn.
- [ ] 7.5 A later emission with the same id replaces the status and the figures of that part in place, the same as `reconcileAskCard`. Expected result: one part for each compaction.
- [ ] 7.6 In `cortexToUiMessage`, add a `data-compaction` case that gives a compaction part. Expected result: a stored divider maps to an `event` message with one compaction part.
- [ ] 7.7 Make `cli/src/tui/components/compaction_block.tsx`. The status `running` renders one muted line: `Summarizing earlier conversation` and then `GLYPHS.ellipsis`.
- [ ] 7.8 A terminal status renders a divider: a full-width row with a rule of `GLYPHS.lineHorizontal` on each side of a muted label.
- [ ] 7.9 The label of `done` is `Summarized earlier conversation`, then `tokensBefore`, `GLYPHS.arrowRight`, and `tokensAfter`, then the duration. `Sep` separates the facts.
- [ ] 7.10 The label of `failed` is `Could not summarize earlier conversation`. When `tokensAfter` exists, the label adds `dropped the oldest turns` and the two token figures.
- [ ] 7.11 Format each token figure with `formatTokens()` and the duration with `Date.formatDuration`. Take each color from `theme` and each span from the emphasis components.
- [ ] 7.12 In `cli/src/tui/layout/message_block.tsx`, add the `compaction` case to the part switch. An `event` message whose only part is a compaction part renders the divider with no left rule.
- [ ] 7.13 In `cli/src/tui/layout/design_gallery.tsx`, add a state exhibit of the compaction block: running, done, failed with a drop, and failed with no drop.
- [ ] 7.14 In `cli/src/tui/hooks/conversation.test.ts`, add these tests:
  - A `running` emission and a `done` emission under one id give one compaction part with the status `done`.
  - A reload of a stored divider gives an `event` message with one compaction part.
  - No tagged mention appears for `data-compaction`.
  - A malformed status gives the status `failed`.
- [ ] 7.15 In the new `cli/src/tui/components/compaction_block.render.test.tsx`, add a frame test of each form. Assert the span colors of the label on `github-light`.
- [ ] 7.16 In `cli/`, run `bun run harness:local`. Run `tsc -p tsconfig.json`. Run `bun test src/tui/hooks/conversation.test.ts src/tui/components/compaction_block.render.test.tsx src/modules/harness`. Run `bun run lint`. Run `bun run format:file` on each changed file under `src/`.
- [ ] 7.17 In `cli/`, run `openspec validate render-the-chat-compaction --strict`. Mark the tasks of that change.

## 8. Documents and final checks

- [ ] 8.1 In `CONTEXT.md`, section "Memory", write the item "Thread history" again. Name the markers, the view of the latest marker, and the compaction. Say that the store deletes nothing.
- [ ] 8.2 In the same section, write the item "Working memory" again. The compaction moves the lasting facts into it, and its record comes after the summary.
- [ ] 8.3 In the same section, write the item on semantic recall again. A conversation operates inside the view of its latest marker.
- [ ] 8.4 In `CONTEXT.md`, section "Loop primitives", add the compaction policy to the item "The loop": the view, the check before a task request, the exchange, and the markers.
- [ ] 8.5 In `CLAUDE.md`, section "Key Components", add one sentence to the item "Chat turn": the root loop compacts at the conversation budget.
- [ ] 8.6 Write each changed sentence of 8.1 to 8.5 in STE. Run `bun ../.claude/hooks/ste-check.ts --file` on each file, and fix each hard finding in the changed text. Do not format a markdown file.
- [ ] 8.7 Run `grep -rnE 'EVICTION_BLOCK_TURNS|DEFAULT_HISTORY_TOKEN_BUDGET|tokenBudget' src CONTEXT.md CLAUDE.md README.md`. Expected result: no match.
- [ ] 8.8 Run `tsc -p tsconfig.json`. Expected result: no error.
- [ ] 8.9 Run `bun test`. Expected result: each unit test passes. A database suite uses Postgres.
- [ ] 8.10 Run `bun run lint`. Expected result: no error. Run `bun run format:file` on each file under `src/` that this change changed.
- [ ] 8.11 In `harness/`, run `openspec validate compact-the-chat-thread --strict`. Expected result: the change is valid.
- [ ] 8.12 In `cli/`, run `bun run harness:local`, `tsc -p tsconfig.json`, `bun test`, and `bun run lint`. Expected result: no error and no failed test.
