## Context

`runAgent` returns `AgentFinish.turnUsage` — the whole turn's rollup, descendant sub-agent loops included, present on the loop that created the accumulator. A host renders it live and then loses it: `appendTurn(threadId, messages): ResultAsync<void, DbError>` persists AI SDK `ModelMessage` envelopes, whose shape has nowhere to put a rollup, and the read path rebuilds a transcript from those envelopes alone.

Three properties of the existing system rule out fixing this above the harness. A chat-path usage record carries `thread_id` but no message or turn id, because outside a `RunFrame` `recordKeyFor` mints a fresh UUID rather than a composed key. `appendTurn` returns no ids, so a host cannot learn what identity storage assigned. And the id a host holds while streaming is its own — the CLI mints one locally at turn start — so it never matches the row. There is no join column in either direction, and a host-side table keyed on the live id would be orphaned by the next reload.

The messages table already carries a per-message `tokens` count, stamped at write time and used by `loadRecent` to window by budget. That is precedent for numeric metadata on a message row, and simultaneously the sharpest hazard in this change: the two numbers look alike and mean different things.

## Goals / Non-Goals

**Goals:**
- A reopened transcript shows the same per-turn figure the live turn showed.
- Hosts get it from the read they already do, without knowing where it is stored.
- The absent/zero distinction survives storage, as it does everywhere else in usage accounting.

**Non-Goals:**
- Per-call attribution to a message. This persists the turn's total.
- Any change to `UsageRecorder`, the record shape, or the OTel counters.
- Backfilling turns written before this change.
- Rendering it. That is the embedder's, and a separate change.

## Decisions

### Decision 1: Store the rollup on the message row, not as a host-owned sidecar

The rollup is persisted by the harness, on the assistant message that completed the turn.

*Why:* the alternative shapes all put a harness fact in host hands. Returning the persisted ids from `appendTurn` and letting each host keep its own table would make every host reimplement the same storage for the same fact, and would leave the managed and OSS hosts free to disagree about what "this turn cost" means. Threading a turn id onto the usage record instead would let a host join its ledger back to a message — a more general answer, but one that only works for a host that keeps a ledger at all, and the question here ("what did this turn cost") is answered by a number the harness already computed. The narrow fact belongs where the turn is.

This also matches how the same information already flows: `AgentFinish` carries the rollup out of the loop for the live surface, and the message row carries it out of storage for the reloaded one. Same fact, two lifetimes.

### Decision 2: The assistant message that ends the turn carries it

Of the messages one `appendTurn` writes, the rollup rides the final assistant message.

*Why:* the rollup describes the turn, and the turn is not a row — but the assistant reply is the row a reader associates with the answer they paid for, and it is where hosts already render duration. Spreading it across the turn's rows would require apportioning a total that was never per-message, and putting it on the user message would attribute a cost to the party that did not incur it. A turn that produced no assistant message (an abort before any output) carries no rollup, which is correct: there is no message on which the figure would mean anything.

### Decision 3: The rollup and the `tokens` count stay separate, and neither substitutes for the other

The stored rollup SHALL NOT be read by `loadRecent`, and the `tokens` count SHALL NOT be presented as reported usage.

The schema carries the distinction too: the column is `reported_usage`, beside the existing `tokens`. A reader meeting both should be able to tell an offline estimate from a provider's report without consulting a document, because the moment they cannot is the moment one gets used for the other.

*Why:* they are different measurements that happen to share a unit. `tokens` is a `js-tiktoken` `cl100k_base` approximation the harness computes at write time precisely so windowing never needs a provider round-trip; it exists for every message, including ones no provider ever saw. The rollup is what a provider reported for a whole turn, absent when nothing reported. Using the rollup for windowing would break budgeting on the turns that lack one; showing `tokens` as usage would present an offline estimate as billing truth. The hazard is that both are plausible-looking integers on the same row, so the separation is stated as a requirement rather than left to naming.

### Decision 4: Absent is absent, and old rows are simply absent

A turn whose calls reported nothing stores no rollup. A message written before this change reads back without one.

*Why:* this is the discipline the whole usage capability is built on — unreported is never zero — and storage is where it is easiest to lose to a `NOT NULL DEFAULT 0`. It also makes the migration free of interpretation: a pre-existing row is indistinguishable from a turn that reported nothing, and both are honestly rendered as "no figure", which is true in both cases. No backfill is attempted, because there is nothing to backfill from — the figures were never recorded.

### Decision 5: It rides the existing read, not a new one

The rollup is carried on the `CortexMessage` the existing conversion produces.

*Why:* hosts already load a transcript through one path, and a reloaded message needs its figure at exactly the moment it is rebuilt. A separate lookup would make every host issue a second query per transcript and decide for itself how to correlate the results — reintroducing, one layer up, the correlation problem this change exists to remove.

## Risks / Trade-offs

- **The two token numbers on one row get confused** by a future reader or a host. → Decision 3 makes the separation normative rather than a naming convention, and the field names carry the distinction. This is the most likely long-term failure mode of the change.
- **The rollup can disagree with the ledger** for the same turn, if a host keeps one and a call's record was delivered but the turn later failed before `appendTurn`. → Accepted and inherent: the ledger records calls as they complete, the rollup records what a completed turn returned. They are different questions, and the existing capability already documents that the counters, the records, and the finish rollups are three views of one capture rather than one number in three places.
- **Landing this change alone changes nothing observable.** The harness defines `appendTurn` but never calls it, so nothing is stored until an embedder passes the rollup, and nothing is shown until it renders what comes back. → Stated in the proposal's impact rather than left implicit, because a harness change that is correct and inert is easy to mistake for a finished feature.
- **Storage grows by a small fixed amount per assistant message.** → Negligible against the message envelope already stored, and bounded by one row per turn.
