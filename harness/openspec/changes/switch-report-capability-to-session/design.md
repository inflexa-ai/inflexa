# Design: switch-report-capability-to-session

## Context

The rebuild of #221 is dormant on `main`. The `report` thread type resolves to the Report Builder agent (`src/runtime/assemble.ts:311-314`), and the spawn operation exists (`src/app/spawn-report-session.ts`). But no caller reaches the operation, and the conversation agent still offers `plan_report` and `submit_report` (`src/agents/conversation-agent.ts:273-284`). The conversation prompt describes the brief flow (`src/prompts/conversation.ts`, the "Report Creation" section).

The #221 policy binds this change: a report session is user-initiated, and on a thin delta the agent advises iteration in the existing report chat. The one-version rule itself lives in the `report-versions` spec already.

The #223 decision record binds the context transfer, and its #309 delta names the mechanism. The intent brief is the argument of the spawn tool. The working-memory render copies into the child context at the spawn, because a live read sees state past the anchor. The shipped spawn operation carries neither part yet, and the turn assembly injects a live render on every turn (`src/app/message-assembly.ts:104-107`). Thus this change carries the transfer.

## Goals / Non-Goals

**Goals:**

- One report path on the roster: a tool that starts a report session.
- The intent brief rides the tool, and the spawn seeds the child context at the anchor.
- The typed refusals of the spawn reach the agent as data.
- The thin-delta advice steers to the existing report chat.
- The prompt describes the session path, and only that path.

**Non-Goals:**

- No removal of the old modules. #313 removes them.
- No new chat data part. The entry point in the chat surface is #312 work, and a part, if one is necessary, lands there.
- No turn-start wiring of `ensureSessionState`. The gateway `load` anchors the session on the first tool call (`src/app/report-session-runtime.ts:175-187`).
- No change to the spawn operation refusal set, and no change to the Report Builder agent.

## Decisions

### D1. The tool id is `start_report_session`, and the module is top-level

The tool id follows the verb-noun form of the conversation roster (`execute_analysis`, `generate_plan`). The module lands at `src/tools/start-report-session.ts`, beside `iterate-report.ts`, because the conversation-agent tools live at the top of `src/tools/`. The `src/tools/report-session/` directory keeps the tools of the report thread only. "Spawn" stays the name of the operation, and the tool surface speaks "start".

### D2. The parent comes from the scope, never from the input

The tool reads `scope.threadId` as the parent conversation. Every chat turn carries it (`cli/src/modules/harness/turn.ts:188`, and `auth/types.ts:37` declares it). A call whose scope carries no thread id refuses as typed data, the same rule as the authoring tools (`src/tools/report-authoring/authoring-tools.ts:277`). An input field for the parent would let the agent name a different thread, thus no such field exists.

### D3. The advice counts user turns, and it is overridable

The #221 policy says "thin delta", and a prompt cannot compare sequence numbers. Thus the tool computes the delta. The unit is the user turn of the parent past the anchor of the newest report child. The tool spawns nothing at a count of one or less, and it names that child.

The unit is a turn, and it is not a raw sequence number. The turn appends after its own loop runs (`app/chat-turn.ts` gives the messages, and the caller appends). Thus the anchor of a child sits before the rows of the ask that made it, and the ask lands one turn later. A rule at zero over the raw sequence would then never fire again after the spawn. The count admits that one turn, and a second user turn is real investigation.

The count reads the genuine-user-start predicate that the thread history already holds (`src/memory/thread-history.ts:230`). Thus a synthetic record of a host never counts as investigation. The rejected alternative was a fixed non-zero sequence threshold, which no fact of the transcript supports.

The input carries one optional boolean, `newSessionAnyway`, and a true value skips the advice.

The eyes gate wins over the advice. A composition without a browser is a permanent condition, and the advice is transient state. Thus the tool checks `hasBrowserUrl(chrome)` first, the same value that the spawn gate reads at its construction (`src/app/spawn-report-session.ts:153`). An advice that masks the permanent fault would hide the deployment gap from the user.

The tool computes the delta from two reads: the children listing narrowed by the parent, and the count of user turns past the anchor. Two concurrent spawns can give two children with one anchor (`src/app/spawn-report-session.ts:179-183`), and the newest `created_at` then wins.

The greatest child anchor comes from a walk of the listing pages, because the listing orders by `updated_at` and not by anchor (`src/memory/thread-store.ts:622`). The walk is cheap: the one-version policy keeps the child count small. The two reads land on the spawn module (`ReportSessionSpawn`), because that module already composes the store and the history over one pool.

### D4. Every degraded condition is ok-channel data

The result is a discriminated union, the same contract as the report-session tools: `refused` (no thread id in scope), `existing-session` (the advice), the four spawn refusals passed through (`no_browser`, `parent_not_found`, `parent_not_a_conversation`, `empty_parent_transcript`), `failed` (a store fault, with a short detail), and `started` (the thread id and the title of the child). The `no_browser` arm carries the detail line of the spawn, thus the agent tells the user that this deployment cannot look at a page. The tool never throws for one of these.

### D5. The wiring stays inside `createConversationAgent`

The tool constructs from `pool` and `chrome`, and both already ride `ConversationAgentDeps` (`src/agents/conversation-agent.ts:117,159`). The roster swap replaces the `planReportTool` and `createReportSubmitTool(...)` entries with the one new tool. No new field crosses `CoreRuntimeDeps`, thus no embedder changes. The `capture` seam of the spawn gate stays unbound here: the sidecar decision makes `chrome.browserUrl` the one route to the eyes, and the conversation deps carry no capture field today.

### D6. The prompt describes one path

The "Report Creation" section of `src/prompts/conversation.ts` rewrites: call `start_report_session` when the user wants a report, tell the user where the session is, and steer a change request to the existing report chat. The section keeps the no-unprompted-reports rule. The "Do NOT" list gains the failure mode: do not compose a report in the conversation, and do not paste report prose in place of a session. The prompt names the mechanism only, per the prompt principles.

### D7. Unused old-path deps stay on the deps bag

`createPreviewPublisher`, `templatesDir`, and `skillsDir` stay on `ConversationAgentDeps`, although only the old tools read them. A deps change is an embedder-facing break, and #313 owns the removal. The change stays one commit, thus a revert restores the old roster in one step.

### D8. The brief is the argument of the tool

The #223 record fixes the intent channel: push only what the ask itself creates. The input of the tool carries the brief beside the override: `objective`, `audience`, `angle`, optional `exclusions`, and optional `openQuestions`. Each field is short prose, and the tool description caps the whole brief at approximately 2000 tokens. The conversation agent authors the brief at the moment of the ask, and no field names a path or a dataset.

### D9. The spawn seeds the child context at the anchor

The spawn operation gains the brief as its second argument. After the thread insert, the spawn composes one context message: the brief, then the copy of the working-memory render at that moment. It appends the message to the child transcript through `appendTurn` (`src/memory/thread-history.ts:344`). The transcript is append-only, thus the copy is frozen at the anchor by construction.

A seed write can fail after the thread insert. The spawn then purges the child through `purgeThread` and returns the fault as typed data, because a context-less report thread is a dead end.

The report turn must not inject the live working-memory render, because a live read sees state past the anchor (the #309 delta). The turn assembly reads the thread type that `prepareChatTurn` already loads, and a `report` thread skips that one tail message. The analysis context and the run activity stay, because the #223 record names the working memory alone.

## Risks / Trade-offs

- [The CLI passes `chrome: {}` (`cli/src/modules/harness/runtime.ts:1080`), thus every local spawn refuses `no_browser` until #312 wires the sidecar] → the refusal is typed and names the absent capability. The delivery branch merges as one unit, thus no release carries the gap.
- [The compiled binary fails `preview_report` without the packed assets] → the #312 asset binding lands on the same branch, before any release (decision D9 of `add-report-design-system`).
- [An agent can call `submit_report` from habit after the swap] → the loop refuses the unknown tool, and the prompt names the one path.
- [Two concurrent turns can both pass the delta gate] → the one-per-thread store rule bounds the cost to one extra empty session.
- [The seed write fails after the thread insert] → the spawn purges the child and returns the fault, thus no context-less thread survives.
- [A weak brief starves the Report Builder] → the transcript stays readable, and the interactive session is the repair path per the #223 record.

## Migration Plan

The change is user-visible: the report capability of a conversation changes shape. A revert of the one commit restores the old roster and the old prompt. No data migrates, and no store changes.

## Open Questions

None.
