# Proposal: switch-report-capability-to-session

## Why

The rebuild of #221 is on `main`, and it is dormant: the `report` thread type resolves to the Report Builder agent, but no tool makes a report thread. The conversation agent still offers the old brief tools. Two report paths in one roster select unpredictably, thus the switch is one atomic change (#314).

## What Changes

- Remove `plan_report` and `submit_report` from the roster of the conversation agent. The two modules stay in the source, and #313 removes them later.
- Add the tool that starts a report session. It runs `createReportSessionSpawn` (`src/app/spawn-report-session.ts`), and it returns each refusal as typed data.
- Carry the intent brief as the argument of the tool, per the #223 decision record. The conversation agent authors it at the moment of the ask.
- Seed the child context at the spawn. The seed holds the brief and a copy of the working-memory render, per the #309 delta.
- Stop the live working-memory render on a report turn. The copy in the child transcript is the record, and a live read breaks the anchor.
- Add the thin-delta advice. The tool counts the user turns of the parent past the anchor of the newest report child. At one turn or less, the tool advises iteration in that report chat, and it spawns nothing. An explicit input field overrides the advice.
- Update the conversation prompt. It describes one report path: start a session, and talk to the Report Builder there.
- **BREAKING** for the agent surface: a conversation turn cannot build a report in place after this change. The user-visible behavior changes here and nowhere else in the rebuild.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-session-spawn`: the capability gains the conversation-agent tool surface. The requirements cover the tool, the brief, the context seed, the one-report-path roster invariant, the typed refusals as data, and the thin-delta advice.
- `report-session-agent`: the report turn reads the copied narrative from its transcript. The turn assembly injects no live working-memory render.
- `iterative-report`: the roster requirement changes. The conversation agent no longer offers `plan_report` and `submit_report`. The tools and the builder stay in the source until their removal.

## Impact

- `src/agents/conversation-agent.ts` — the roster swap and the new tool wiring.
- `src/prompts/conversation.ts` — the "Report Creation" section describes the session path.
- A new tool module, `src/tools/start-report-session.ts`.
- `src/app/spawn-report-session.ts` — the spawn gains the brief argument and the context-seed write.
- `src/app/chat-turn.ts` and `src/app/message-assembly.ts` — the report turn skips the live working-memory tail.
- The spawn deps (`pool`, `chrome`) already ride `ConversationAgentDeps`. No new seam.
- The old path stays reachable in the source, thus a revert of this change is one commit.
