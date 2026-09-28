## Why

A report session on staging showed two costs of the context that the harness did not see:

- The estimate of the view gave 141k tokens, but the provider billed 302k tokens. Thus the view stayed under the budget of 150,000, and no compaction started. The estimate counted each picture of a tool result as 0 tokens, and it does not count the system prompt and the tools.
- One look of `examine_page` gave 6 slices. The look cost about 20k tokens, and it showed only 68% of the page. Each later request of the turn sent the pictures again.

## What Changes

The compaction of the chat thread:

- The loop stores the input tokens that the provider reports for a request on the assistant message of the reply, under the harness key `requestInputTokens`.
- The loop compares a budget with a measure of the view in the tokens of the provider. The measure is the input tokens of the latest request after the latest marker, plus the estimate of each message from its reply. Without such a request, the measure is the estimate of the whole view.
- The estimate counts a picture by its pixel area, `ceil(width × height / 750)`, from the image header. A picture of unknown size counts as 1,600 tokens. The `tokens` column uses the same count.
- A `conversation` thread gets a turn-start budget of 150,000 and a budget of 200,000 during a turn. A `report` thread gets no turn-start compaction, and a budget of 250,000 during a turn.
- `conversationBudget` replaces the budget during a turn. It lowers the turn-start budget only when it is lower. `CompactionPolicy` gets the optional `turnStartBudget`.
- A turn-start compaction summarizes the view before the current turn. Its summary marker carries `keptTurns: 1`, and the view keeps that turn after the summary, without its context records and its reasoning. A mid-turn compaction does not change.
- The marker, the `data-compaction` part, and the log records carry `trigger: "turn-start" | "mid-turn"`.
- The compaction requests ask for the last request of the user.

The report agent:

- `examine_page` renders at a device scale of 0.5 of the layout of 1440 CSS pixels. A slice holds 4,000 CSS pixels (a picture of 720 by 2000 pixels), and a look holds a maximum of 5 slices.
- `examine_page` takes an optional block id, and the look then holds that block alone. Each rendered block carries a `data-block` attribute. A block look stamps the seen hash, the same as a whole look. An unknown block gives `no-block`.
- The look gives a digest of the faults: one entry with a count for each repeated fault, a cap on each text, and a placeholder for each inline base64 data.
- `finish_draft` gives the pass and the warnings, not the document. `preview_report` and `record_report_version` give the advisory warnings.
- `add_block` emits one `add-block` event for each block that it adds: a section and each block under it.
- `list_pinned_artifacts` gives no hash. With no input, it gives the path, the file type, and the count of the header columns of each artifact. With `path`, it gives that artifact with its header columns (`artifact`), or `not-pinned`.
- The report prompt teaches a shorter loop: one call for a whole section, one look at the whole page, and then a look at each repaired block. The agent does not call `finish_draft` directly before a preview. An amend is the whole set of changes of one user request.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-agent-loop`: the measure of the view, the turn-start compaction, the kept turn of a summary, and the trigger on the part and the log.
- `harness-thread-history`: the kept turns of a summary, the measure and the rollup, the picture count, and the trigger on the divider.
- `ai-sdk-message-storage`: the trigger and the kept turns of a marker, and the input tokens of a request on an assistant message.
- `chat-turn`: the budgets for each thread type, and the turn-start compaction of the root loop.
- `report-verification`: the half-scale capture, the slice size and the budget, the block look, and the fault digest.
- `report-render`: the block mark on each rendered block.
- `report-authoring`: `finish_draft` gives no document, and the preview and the record give the warnings.
- `report-session-agent`: the listing gives no hash and one artifact by its path, and the prompt teaches the shorter loop.
- `provenance-seam`: an add emits one event for each block that it lands.

## Impact

- Harness source: `src/loop/run-agent.ts`, `src/loop/compaction.ts`, `src/memory/` (the count, the new header reader, the view, the marks, the divider), `src/contracts/`, `src/app/chat-turn.ts`, and `src/prompts/compaction.ts`.
- Report source: `src/lib/page-capture.ts`, `src/report-render/views/`, `src/tools/report-session/` (the look, the new fault digest, the preview, the record, the listing), `src/tools/report-authoring/authoring-tools.ts`, and `src/prompts/report-session.ts`.
- `DEFAULT_CONVERSATION_BUDGET` stays 150,000, but it is now the turn-start budget. A host that passes `conversationBudget` now sets the budget during a turn.
- `CompactionPart` gets the optional `trigger`. A stored marker from before this change has no trigger and keeps no turn.
- The tool results change for a consumer:
  - The listing loses `hash` and the column names.
  - `finish_draft` loses the document.
  - The faults of a look become entries with a count.
  - `CaptureCoverage` gets the arms `block` and `no-block`.
- Database: no new table and no new column. The input tokens ride in the harness namespace of `providerOptions`.
- Order of the archive: this change modifies requirements that `compact-the-chat-thread`, `tile-the-tall-page-capture`, and `flatten-file-written` add or modify. Archive those changes first, and the changes that `compact-the-chat-thread` names, before this change.
