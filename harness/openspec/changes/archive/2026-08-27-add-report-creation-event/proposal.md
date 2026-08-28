# Add report creation event

## Why

The observation seam names each authoring act of a report session, but no event
marks the birth of a session. Thus a consumer of the analysis document reads the
first block operation and infers the moment that the user asked for a report.
The inference is wrong when the session stays empty, and it is late when the
first act comes minutes later. The document also tells nothing about the
conversation thread that the report grew out of.

## What Changes

- The `ReportObservationEvent` union gains a ninth member, `create-session`. It
  carries the analysis id, the thread id, `sessionKind`, and the optional parent
  thread id. It names no block.
- `sessionKind` names the two kinds of thread of an analysis, `conversation` and
  `report`. Thus the document tells the whole tree of the sessions.
- The two callers of `ThreadStore.createThread` emit the event, each after its
  own row lands. The store emits nothing, because the state layer knows no seam.
- The turn emits on the branch that writes a new conversation thread. The spawn
  of a report session emits after the child lands, before any authoring act.
- The optional seam reaches the spawn from the composition root, through the
  conversation agent and the tool that starts a session. It reaches the turn
  through the deps of `prepareChatTurn`. An unbound seam emits nothing, and a
  refused write emits nothing.

## Capabilities

### New Capabilities

<!-- No new capability. The change extends the vocabulary of an existing seam. -->

### Modified Capabilities

- `report-observation-seam`: the vocabulary of the events grows from eight
  actions to nine, and the new action marks the creation of the session.

## Impact

- `src/tools/report-observation.ts` — the ninth member of the union.
- `src/app/spawn-report-session.ts` — the optional seam and the emit at the
  successful spawn.
- `src/app/chat-turn.ts` — the optional seam and the emit at the branch that
  writes a new conversation thread.
- `src/tools/start-report-session.ts`, `src/agents/conversation-agent.ts`, and
  `src/runtime/assemble.ts` — the seam passes from the composition root to the
  spawn.
- No storage change, no schema change, and no new dependency.
