## Why

`runAgent` reports what a turn consumed on `AgentFinish.turnUsage`, and a host can render it the moment the turn ends — but nothing keeps it. The figure lives only in whatever the host held in memory, so reopening a conversation shows the transcript with the cost stripped out of it.

Nor can a host reconstruct it. The usage records the loop delivers carry a thread, not a message or a turn, because outside a `RunFrame` the key is freshly minted per call; `appendTurn` returns `void`, so a host never learns the id storage assigned; and the id a host held while streaming is its own, not the row's. There is no join column in either direction. A host-side workaround keyed on a live id appears to work until the process restarts, which is worse than the gap.

The turn's cost is a fact the harness computes about a turn it persisted. Storing it beside that turn is the only place the two can be kept together.

## What Changes

- **`appendTurn` accepts a turn's reported usage rollup** and stores it on the assistant message that completed the turn, in the same transaction that writes the turn.
- **The stored rollup rides back out on read**, so a host that reloads a conversation renders the same figure it showed live, without a second query and without knowing where it was kept.
- **The rollup is kept distinct from the existing per-message `tokens` count.** That count is a `js-tiktoken` approximation computed at write time to window `loadRecent` by budget; the rollup is what a provider actually reported. They answer different questions and must never be read for each other's purpose.
- **Absent stays absent** — a turn whose calls reported nothing stores no rollup rather than a zeroed one, and a message written before this change reads back without one.

## Capabilities

### New Capabilities

None. This extends an existing write path and its read; a separate capability would split one turn's storage across two specs.

### Modified Capabilities
- `harness-thread-history`: `appendTurn` gains the optional rollup and stores it on the turn's assistant message; the `CortexMessage` conversion carries it back to hosts.

## Impact

- **Modified**: the thread-history write and read paths (`src/memory/`), the messages table (one additive nullable `reported_usage jsonb` column), and the `CortexMessage` shape hosts read.
- **Migration**: additive and backward-compatible. Existing rows carry no rollup and read back as absent, which is exactly what "nothing was reported" already means everywhere else in usage accounting.
- **Embedder follow-up, not in scope, and required for any of this to be observable**: the harness defines `appendTurn` but never calls it — the host does. So this change stores nothing until an embedder passes the turn's rollup at its own `appendTurn` call site, and shows nothing until it renders what comes back. Both halves are the embedder's, harness-first per the subsystem boundary. Landing this change alone is correct and inert; treating it as the whole feature is the mistake it is easy to make here.
- **Not in scope**: attributing individual LLM calls to a message. This stores the turn's total, which is what a transcript shows; per-call attribution would need a turn id on the record itself and answers a different question.
