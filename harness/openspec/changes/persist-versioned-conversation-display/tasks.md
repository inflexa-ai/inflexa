## 1. Display Storage Contract

- [x] 1.1 Define the stored parts vocabulary as the display representation minus its discriminant, including a `tool-call` data part whose single required outcome carries its whole terminal state (`ok`/`error`/`denied`/`incomplete`).
- [x] 1.2 Define the versioned `ai-sdk-ui-messages` envelope schema, its parser, and the per-part data schemas `validateUIMessages` enforces.
- [x] 1.3 Add `display_envelope JSONB` to the `messages` state initialization path and document that it rides the first row of each append.
- [x] 1.4 Add parser tests covering valid envelopes, unsupported AI SDK/display versions, malformed parts, and unknown data payloads.

## 2. Conversation Display Recorder

- [x] 2.1 Implement the harness-owned recorder that forwards live events while folding them into complete ordered display messages with copy-on-receive semantics.
- [x] 2.2 Place every part through one `upsert` so tool-call completion and `ask` reconciliation share one latest-wins-by-id path that preserves first-seen position.
- [x] 2.3 Record each call's outcome and detail as received; record it `incomplete` at dispatch so an unfinished call needs no closing pass.
- [x] 2.4 Filter transient and sub-agent parts through the conversation part registry.
- [x] 2.5 Cover text/card/text ordering, out-of-order tool completion, the three outcomes, approval terminal states, interrupted turns, and failed preview parts in recorder tests.

## 3. Atomic Append and Reads

- [x] 3.1 Fold `appendTurn` to one signature taking a turn value of model messages, display messages, and the reported rollup; write all three in the existing per-thread transaction.
- [x] 3.2 Add `conversationRecordTurn` so a host-appended record carries its own display projection.
- [x] 3.3 Keep `loadRecent` model-only and prove display bytes do not affect token accounting, eviction, ordering, or provider-message equality.
- [x] 3.4 Return the stored display envelope and the stored rollup from `loadPage`, and ensure tail retraction removes both with their rows.
- [x] 3.5 Update thread-history tests for round trips, rollback atomicity, pagination, retraction, and soft-deleted thread behavior.

## 4. Startup Migration

- [x] 4.1 Implement an idempotent bounded startup migration that groups legacy rows by turn and writes only null envelopes.
- [x] 4.2 Recover each legacy call's outcome from its paired `tool-result` block — reporting `incomplete` when there is none — and its detail from the persisted input, using the assembled conversation roster.
- [x] 4.3 Move the migration after `assembleCoreRuntime` in the boot sequence and document why it is still before any traffic.
- [x] 4.4 Treat missing mutable resources as a migrated cardless projection, while making database faults and invalid stored envelopes block startup with thread/turn identity.
- [x] 4.5 Add migration tests for reconstructable cards, recovered failures, missing resources, partial batches, retry idempotency, and failure diagnostics.

## 5. Runtime Read

- [x] 5.1 Implement the transcript read as a concatenation of stored projections, folding each append's rollup onto its assistant reply.
- [x] 5.2 Skip a row with no stored projection; add no runtime fallback to reconstruction.
- [x] 5.3 Remove the migration renderer, the card resolver, and the call-detail resolver from the embedder-facing barrel.
- [x] 5.4 Verify conversation run cards still reference independently replayed DBOS run streams, and that no DBOS table, stream event, or workflow path is migrated.
- [ ] 5.5 Update the `cli` consumer in its own subsystem change: the turn value at its `appendTurn` call site, `conversationRecordTurn` for run-outcome records, the transcript read, and rendering an `incomplete` call.

## 6. Verification

- [x] 6.1 Add live-versus-reloaded parity tests for every durable conversation part family and for mixed text/tool/card ordering.
- [x] 6.2 Run the harness formatter on changed source files, then `tsc -p tsconfig.json` and `bun test`.
- [x] 6.3 Validate the OpenSpec change.
