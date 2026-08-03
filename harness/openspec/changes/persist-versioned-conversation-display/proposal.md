## Why

Conversation display parts are emitted live but not persisted, so transcript reload reconstructs what the user saw: it matches historical tool names, re-runs card builders against current database and filesystem state, recovers each call's outcome by pairing tool-result blocks, and recomputes each call's one-line detail from the tool's input schema. Reload therefore depends on tool identity, on schemas, and on mutable resources — none of which describe what was actually shown.

Every one of those recoveries is a separate inference that can be wrong, and each is load-bearing for something a reader trusts: a renamed tool loses its card, a moved workspace loses its preview, a tool whose schema changed loses its detail. The fix is not a better inference. It is to store the display projection, once, at the moment it is produced.

## What Changes

- Persist each append's complete display projection in a versioned envelope alongside its unchanged AI SDK `ModelMessage` history, on the first row of the append.
- Keep model history and display history as separate projections: LLM history reads only model envelopes, and the transcript read consults only display envelopes.
- Make the stored parts vocabulary mirror the display representation exactly. AI SDK `UIMessage` remains the container (identity, role, ordering, metadata, validation); every non-text part rides as a typed data part whose payload is the display part minus its discriminant. A tool call therefore stores its whole terminal state in one four-way outcome — `ok`, `error`, `denied`, `incomplete` — plus its one-line detail, neither of which AI SDK's own tool part can hold.
- Fold `appendTurn` to a single signature taking one turn value — model messages, display messages, and the reported usage rollup — so a turn cannot be appended with its display silently dropped.
- Give a host-appended record its own display projection through a harness-owned constructor, so out-of-band work is replayed rather than stored and never shown.
- Replace the runtime reconstruction path with a concatenation of stored projections, and confine reconstruction to a startup migration that freezes each legacy turn once. The migration recovers the outcome and detail it can, and the resolvers leave the embedder-facing surface.
- Leave DBOS workflow/run event streams unchanged.

## Capabilities

### New Capabilities

- `conversation-display-storage`: the durable display projection — its parts vocabulary, versioned envelope, live recorder, atomic append, and one-time startup migration.

### Modified Capabilities

- `harness-thread-history`: `appendTurn` takes one turn value and persists all three projections atomically; the transcript read concatenates stored projections; legacy turns are migrated once at startup.
- `display-cards`: conversation cards reload from their stored payload, never rebuilt from a tool name.

## Impact

- Affects conversation turn orchestration, the `ThreadHistory` interface and `messages` schema, the display recorder, startup migration, and the embedder-facing surface.
- **Breaking for embedders**: `appendTurn` takes a turn value rather than a message array; the transcript read is `storedMessagesToCortex` over stored projections; `contentToCortexMessages`, `createCardResolver`, and `createDetailResolver` leave the public barrel. The `cli` consumption is a separate change in that subsystem.
- Adds a display-projection column to `messages`. Existing local databases are migrated at startup; a legacy row that cannot reconstruct a card receives a valid cardless projection rather than blocking forever on a missing mutable resource.
- Does not change provider requests, token accounting, prompt-cache behavior, workflow execution, or DBOS stream persistence.
