## 1. Run-State Read Models

- [x] 1.1 Add dedicated state queries for bounded non-terminal activity and active-first paged inspection, including total counts, without changing the chronological `queryRunsByAnalysis` contract used by embedder/UI consumers.
- [x] 1.2 Add database tests proving running-before-suspended-before-terminal ordering, ordering before pagination, true totals, and the 20-row activity projection with omitted counts.

## 2. Conversation Run Activity

- [x] 2.1 Implement the analysis-wide Run Activity renderer with full run/plan ids, absolute start times, compact ages, distinct running/suspended sections, explicit empty/unavailable states, and bounded truncation metadata.
- [x] 2.2 Load Run Activity during `prepareChatTurn` and inject it in `assembleMessages` after analysis context and before working memory without including it in the standalone persisted user message.
- [x] 2.3 Extend chat-turn and message-assembly tests for tail order, cross-thread analysis scope, empty/unavailable/truncated rendering, cache-prefix preservation, and non-persistence.

## 3. Run Inspection

- [x] 3.1 Extend `inspect_run` list mode with validated `page`/`pageSize` inputs and `total`/`page`/`pageSize`/`hasMore` output over the dedicated active-first query.
- [x] 3.2 Refactor targeted inspection into explicit `not_found`, `in_progress`, `suspended`, and `terminal` variants, retaining underlying run status and withholding summary/synthesis paths until terminal.
- [x] 3.3 Implement abort-aware `waitForTerminalSeconds` polling with the 1–30 second cutoff, immediate terminal/suspended/not-found behavior, cutoff metadata, and the self-run wait guard.
- [x] 3.4 Extend `inspect_run` tests for pagination validation and ordering, every targeted state, path readiness, terminal transition, cutoff, cancellation, and self-run behavior.

## 4. Agent Loop Guidance

- [x] 4.1 Return `status: "in_progress"` with every newly launched or deduplicated `execute_analysis` run id and update its model-facing description.
- [x] 4.2 Update the conversation prompt and `inspect_run` description to allow one user-directed bounded wait per turn, stop after an in-progress cutoff, and preserve autonomous pull-only workflow completion.
- [x] 4.3 Add or update execute-analysis and conversation-agent prompt tests to pin the launch state and anti-polling instructions.

## 5. Verification

- [x] 5.1 Format every changed `src/` file with the harness's file-scoped formatter.
- [x] 5.2 Run focused run-state, message-assembly/chat-turn, inspect-run, execute-analysis, and conversation-agent tests.
- [x] 5.3 Run the harness TypeScript build and full supported test command, resolving any regressions without changing the agreed contracts.
