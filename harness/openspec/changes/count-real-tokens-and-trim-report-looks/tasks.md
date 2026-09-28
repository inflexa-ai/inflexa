# Tasks

Each path is relative to `harness/`.

This change builds on `compact-the-chat-thread` and `tile-the-tall-page-capture`. The code of the two changes is on the branch.

## 1. The measure of the view

- [x] 1.1 Add `src/memory/image-dimensions.ts`. It reads the size of a PNG, a JPEG, a GIF, or a WebP picture from its header. It decodes no pixel.
- [x] 1.2 In `src/memory/count-tokens.ts`, count each picture as `ceil(width × height / 750)`. Count a picture of unknown size as `UNKNOWN_IMAGE_TOKENS` (1,600). Count each other file as 0.
- [x] 1.3 In `src/memory/ai-sdk-message-storage.ts`, add `REQUEST_INPUT_TOKENS_KEY`, `withRequestInputTokens`, and `requestInputTokensOf`.
- [x] 1.4 In `src/loop/run-agent.ts`, mark the assistant message of each reply with the input tokens of its request.
- [x] 1.5 In `src/memory/conversation-view.ts`, add `measureView`. It starts at the latest figure after the latest marker, or it gives the estimate of the view.
- [x] 1.6 Add the tests: the picture count, the header reader, the round trip of the figure, the measure, and the wire test on the three provider arms.

## 2. The turn-start compaction

- [x] 2.1 In `src/loop/compaction.ts`, add the optional `turnStartBudget` to `CompactionPolicy`.
- [x] 2.2 In `src/loop/run-agent.ts`, compare the measure with the turn-start budget before the first request. Run the exchange on the view before the user message of the current turn.
- [x] 2.3 Give a turn-start summary marker `keptTurns: 1`, and give each marker its `trigger`.
- [x] 2.4 In `src/memory/conversation-view.ts`, keep the kept turns of a summary marker after the summary, without their context records and their reasoning.
- [x] 2.5 Carry `trigger` on `CompactionPart`, on its schema, on the divider, and on each log record of a compaction.
- [x] 2.6 In `src/app/chat-turn.ts`, set the budgets for each thread type: `DEFAULT_CONVERSATION_BUDGET`, `CONVERSATION_TURN_BUDGET`, and `REPORT_TURN_BUDGET`. Apply `conversationBudget`.
- [x] 2.7 In `src/prompts/compaction.ts`, ask for the last request of the user.
- [x] 2.8 Add the tests: the turn-start exchange, the kept turn, the trigger, the budgets for each thread type, and the view of a summary with a kept turn.

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
