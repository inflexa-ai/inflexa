## Why

A report session on staging showed two costs of the context that the harness did not see:

- The estimate of the view gave 141k tokens, but the provider billed 302k tokens. Thus the view stayed under the budget of 150,000, and no compaction started. The estimate counted each picture of a tool result as 0 tokens, and it does not count the system prompt and the tools.
- One look of `examine_page` gave 6 slices. The look cost about 20k tokens, and it showed only 68% of the page. Each later request of the turn sent the pictures again.

## What Changes

The compaction of the chat thread:

- The loop stores the input tokens that the provider reports for a request on the assistant message of the reply, under the harness key `requestInputTokens`.
- Before a request, the loop compares a budget with the input tokens of the last request. A marker after the last request gives no figure, thus the loop makes no check until the next request reports one. The loop makes no local estimate for the check.
- Each agent declares its compaction rules in `AgentDefinition.compaction` (`CompactionRules`): a budget during a turn, and an optional turn-start budget. An agent with no rules never compacts.
- The conversation agent compacts above 150,000 tokens before the user message of a turn, and above 200,000 tokens during a turn. The report session agent compacts only during a turn, above 250,000 tokens.
- The chat turn builds only the mechanism of the policy. It no longer takes `conversationBudget`, and the harness no longer exports `DEFAULT_CONVERSATION_BUDGET`.
- `runAgent` takes the user message and its context records of a turn as `turnInput`. The loop does the turn-start compaction before it appends the input. After a turn-start summary, the input drops its context records.
- The chat turn stores the user message when the loop sends it. The rows of a turn-start compaction land before the user message, with no turn record. Thus the stored order is the sent order.
- A summary marker keeps no turn. After a summary, when the first request still reports input tokens over the budget, the run compacts no more.
- The marker, the `data-compaction` part, and the log records carry `trigger: "turn-start" | "mid-turn"`.
- The marker and the part carry no `tokensAfter`.
- A compaction with no summary no longer drops the oldest turns. The loop writes no marker, emits `failed`, logs at `error` level, and compacts no more in the run.
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

- `harness-agent-loop`: the budget on the last request, the turn-start compaction, the stop after a summary, the compaction with no summary, and the part.
- `harness-thread-history`: the three token measurements, and the divider.
- `ai-sdk-message-storage`: the figures of a marker, the stored drop marker, and the input tokens of a request on an assistant message.
- `chat-turn`: the rules of the agent, the store of the user message when the loop sends it, and the rows of a turn-start compaction.
- `report-verification`: the half-scale capture, the slice size and the budget, the block look, and the fault digest.
- `report-render`: the block mark on each rendered block.
- `report-authoring`: `finish_draft` gives no document, and the preview and the record give the warnings.
- `report-session-agent`: the listing gives no hash and one artifact by its path, and the prompt teaches the shorter loop.
- `provenance-seam`: an add emits one event for each block that it lands.

## Impact

- Harness source: `src/loop/` (the check, the input of a turn, the rules), `src/memory/` (the marks, the latest figure, the view, the divider), `src/contracts/`, `src/agents/` (the rules of each agent), `src/app/chat-turn.ts`, `src/app/message-assembly.ts`, and `src/prompts/compaction.ts`.
- Report source: `src/lib/page-capture.ts`, `src/report-render/views/`, `src/tools/report-session/` (the look, the new fault digest, the preview, the record, the listing), `src/tools/report-authoring/authoring-tools.ts`, and `src/prompts/report-session.ts`.
- The public API changes for a host:
  - `CompactionRules`, `AgentDefinition.compaction`, and `RunAgentOptions.turnInput` are new.
  - `conversationBudget` and `DEFAULT_CONVERSATION_BUDGET` are removed. A host that gives its own agent for a chat thread declares the rules on that agent.
  - `prepareChatTurn` gives `history` in place of `messages`: the view before the turn, with no user message.
- `CompactionPart` gets the optional `trigger`. The harness no longer emits `tokensAfter`. The field stays optional in the contract only for a part that an older harness stored. The CLI changes only its doc comments on the two token fields.
- A stored marker from before this change has no trigger, and the helper ignores its `tokensAfter`. The view still obeys a stored drop marker.
- A failed compaction logs at `error` level. Thus the log alert on the error lines of a workload sees it.
- After a failed compaction, a request can pass the context window. The provider then refuses it, and the turn fails. The person continues with a new turn.
- A provider that reports no input tokens gives no figure. Thus a conversation on such a provider never compacts.
- The tool results change for a consumer:
  - The listing loses `hash` and the column names.
  - `finish_draft` loses the document.
  - The faults of a look become entries with a count.
  - `CaptureCoverage` gets the arms `block` and `no-block`.
- Database: no new table and no new column. The input tokens ride in the harness namespace of `providerOptions`.
- Order of the archive: this change modifies requirements that `compact-the-chat-thread`, `tile-the-tall-page-capture`, and `flatten-file-written` add or modify. Archive those changes first, and the changes that `compact-the-chat-thread` names, before this change.
