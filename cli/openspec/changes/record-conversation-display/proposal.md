## Why

The harness persists what a turn displayed, at the moment it displays it, and replays that projection verbatim. It cannot produce the projection on its own: the recorder wraps the turn's event sink, and this host owns the sink.

Until it is wired, every turn this host runs is stored with no display projection. It replays as nothing, and the reload path this change removes — rebuilding cards from tool names and workspace state, re-deriving each call's detail from the tool's current schema — is the only thing keeping the transcript populated. That path is what makes a reloaded conversation a function of today's code rather than a record of what the user saw.

## What Changes

- The turn engine wraps its emit sink in the harness display recorder and hands the recorded projection to `appendTurn` alongside the model messages and the usage rollup.
- `chat` and `ask` become functions of that sink rather than values closed over the raw one, so the streaming provider's text deltas and the approval gateway's parts cannot reach the surface by a path the recorder never sees.
- The reload seam collapses to a synchronous read of stored projections: no pool, no analysis id, no tool roster, no card or detail resolver, and nothing that can fail.
- A run-outcome record is appended through the harness's record constructor, so it carries its own projection instead of being stored, read by the model, and never shown.
- A call that was in flight when a turn was interrupted replays as `running` rather than as a success.

## Capabilities

### Modified Capabilities

- `tui-harness-chat`: the turn engine records the display projection and persists it with the turn; the reload path replays stored projections and reconstructs nothing.

## Impact

- `src/modules/harness/turn.ts` — the recorder, the `chat`/`ask` sink parameters, and the turn value at `appendTurn`.
- `src/modules/harness/chat.ts` and `src/tui/hooks/conversation.ts` — both callers supply `chat`/`ask` as functions of the sink.
- `src/tui/hooks/conversation.ts` — the `toCortex` seam, `loadMessages`, and the reloaded tool part.
- `src/tui/hooks/run_completion.ts` — the record append.
- Removed: the workspace-root degradation branch on reload, the `ResultAsync` bridge around the converter, and the card/detail resolver construction. A moved or deleted anchor no longer affects a transcript read, because nothing is resolved at read time.
