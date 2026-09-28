# Tasks

Each path is relative to `harness/`. A path that starts with `../cli/` is in the CLI.

This change builds on `compact-the-chat-thread` and `tile-the-tall-page-capture`. The code of the two changes is on the branch.

## 1. The check on the input tokens of the last request

- [x] 1.1 In `src/memory/ai-sdk-message-storage.ts`, add `REQUEST_INPUT_TOKENS_KEY`, `withRequestInputTokens`, and `requestInputTokensOf`.
- [x] 1.2 In `src/loop/run-agent.ts`, mark the assistant message of each reply with the input tokens of its request.
- [x] 1.3 In `src/memory/conversation-view.ts`, add `lastRequestInputTokens`. It gives the latest figure, or no figure when a marker comes after that figure.
- [x] 1.4 Remove `measureView`, the picture count of `src/memory/count-tokens.ts`, and `src/memory/image-dimensions.ts`.
- [x] 1.5 In `src/loop/compaction.ts`, add `CompactionRules` with `budget` and the optional `turnStartBudget`. Make `CompactionPolicy` extend it.
- [x] 1.6 In `src/loop/types.ts`, add the optional `AgentDefinition.compaction`.
- [x] 1.7 In `src/agents/`, give the conversation agent a turn-start budget of 150,000 and a budget of 200,000. Give the report session agent a budget of 250,000.
- [x] 1.8 In `src/app/chat-turn.ts`, build the policy from the rules of the agent, and give no policy to an agent with no rules. Remove `conversationBudget` and `DEFAULT_CONVERSATION_BUDGET`.
- [x] 1.9 In `compactOverBudget` of `src/loop/run-agent.ts`, make no check without a figure after the latest marker. After a summary, stop the compaction and log a warning when the first figure still exceeds the budget.
- [x] 1.10 Add the tests of the round trip of the figure, and the wire test on each provider arm.
- [x] 1.11 Replace the tests of `measureView`, of the picture count, and of `conversationBudget`. Add the tests: `lastRequestInputTokens`, an agent with no rules, and the stop after a summary.

## 2. The turn-start compaction and the compaction with no summary

- [x] 2.1 In `src/loop/run-agent.ts`, add `RunAgentOptions.turnInput` and `startTurn`. Compare the latest figure with the turn-start budget, compact the history, and then append the input.
- [x] 2.2 After a turn-start summary, append the input with no context record. After a turn-start exchange with no summary, append the whole input.
- [x] 2.3 Give each marker its `trigger`. Remove `keptTurns` from the summary marker, and remove `tokensAfter` from each marker.
- [x] 2.4 In `src/memory/conversation-view.ts`, remove the kept turns of a summary marker. A summary marker empties the body again.
- [x] 2.5 In `src/app/message-assembly.ts`, give the history and the input of the turn separately.
- [x] 2.6 In `src/app/chat-turn.ts`, store the user message in the round sink when the loop sends it. Write the rounds of a turn-start compaction with `appendTurn` before the turn opens.
- [x] 2.7 Carry `trigger` on `CompactionPart`, on its schema, on the divider, and on each log record of a compaction.
- [x] 2.8 Remove the drop. After an exchange with no summary, write no marker and no records, emit `failed`, log at `error` level, and compact no more in the run.
- [x] 2.9 Delete `keptTurnsForDrop` and `viewTokens`. Keep the `drop` kind of the marker schema and the view rule for a stored drop marker. Emit no `tokensAfter`.
- [x] 2.10 In `src/prompts/compaction.ts`, ask for the last request of the user.
- [x] 2.11 In `../cli/src/types/session.ts` and `../cli/src/tui/components/compaction_block.tsx`, change the doc comments of `tokensBefore` and `tokensAfter`.
- [x] 2.12 Add the tests: the turn-start exchange, the stored order, the input with and with no records, and a turn that ends before its user message.
- [x] 2.13 Add the tests of the exchange with no summary and of the trigger. Remove the tests of the kept turn of a summary and of `tokensAfter`.

## 3. The look of the report agent

- [x] 3.1 In `src/lib/page-capture.ts`, set the device scale to 0.5, the slice to 4,000 CSS pixels, and the budget to 5 slices.
- [x] 3.2 Add `src/report-render/views/block-mark.ts`, and mark each block of each view with `data-block`.
- [x] 3.3 Add the block capture: the union box of the marked elements, a margin of 16 CSS pixels, the slices, and the `no-block` coverage.
- [x] 3.4 In `src/tools/report-session/examine-page.ts`, add the optional `blockId`, the `no-block` outcome, and the call detail of a block look.
- [x] 3.5 Add `src/tools/report-session/page-faults.ts`, and give the faults of a look as a digest.
- [x] 3.6 Add the tests: the half-scale slices, a page of 16,000 pixels, the block capture, the block mark, the block look, and the digest.

## 4. The draft, the provenance, and the listing

- [x] 4.1 In `src/tools/report-authoring/authoring-tools.ts`, give a pass of `finish_draft` with the warnings and no document.
- [x] 4.2 Give the warnings of the finish on the `gaps`, `rendered`, and `recorded` outcomes of `preview_report` and `record_report_version`.
- [x] 4.3 Emit one `add-block` event for each block that `add_block` lands, in document order.
- [x] 4.4 In `src/tools/report-session/list-artifacts.ts`, remove the hash, and give the count of the header columns in the listing.
- [x] 4.5 Give one artifact with its header columns for a `path` input, and give `not-pinned` for a path that the pin does not hold.
- [x] 4.6 Add the tests for 4.1 to 4.4.

## 5. The prompt

- [x] 5.1 In `src/prompts/report-session.ts`, teach the add of a whole section, the one look at the whole page, and the block look after a repair.
- [x] 5.2 Tell the agent not to call `finish_draft` directly before a preview.
- [x] 5.3 Define an amend as the whole set of changes of one user request.
- [x] 5.4 Tell the agent to get the column names from the listing tool, with the path of the artifact.

## 6. The proof

- [x] 6.1 Run `tsc -p tsconfig.json`, `bun test`, and `bun run lint`.
- [x] 6.2 Run `openspec validate count-real-tokens-and-trim-report-looks --strict` from `harness/`.
