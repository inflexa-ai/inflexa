## Context

The conversation loop uses AI SDK `ModelMessage` as its exact provider-facing history and persists each message in a versioned envelope. Tools also emit display data through `EmitFn`; a host renders those events live, but storage discards them. Reload therefore rebuilds the display from the model transcript: `content-to-cortex.ts` recognizes selected tool-call names, `reconstruct-cards.ts` rebuilds cards from tool input plus current database/filesystem state, `indexOutcomes` recovers how each call ended by pairing `tool-result` blocks, and `createDetailResolver` recomputes each call's one-line detail by re-parsing the persisted input against the tool's current schema.

That read path couples historical display to tool names, tool schemas, workspace layout, and mutable resources. It also cannot reproduce parts that are not derivable from a tool call at all — report-preview failures and approval outcomes among them. Workflow/run events are a separate lifetime already persisted in the DBOS stream.

## Goals / Non-Goals

**Goals:**

- Persist the complete ordered display projection that was shown live, losslessly.
- Keep exact AI SDK `ModelMessage` persistence and LLM history behavior unchanged.
- Leave the runtime read with nothing to infer: no tool names, no schemas, no filesystem, no database.
- Migrate existing local databases once, at startup, and leave reconstruction with no runtime caller.
- Keep display persistence atomic with the model turn and compatible with turn pagination/retraction.

**Non-Goals:**

- Reconstruct the unknowable original display of historical turns; migration freezes what the current renderer can produce.
- Persist resolved file bytes, preview bytes, or host-specific locations.
- Change DBOS workflow/run event storage or replay.
- Make the display projection the source from which provider-facing `ModelMessage`s are regenerated.
- Render any of it. Host rendering is a separate change in `cli/`.

## Decisions

### D1 — Store two projections of one append

`ModelMessage` remains the provider-facing source of truth. A nullable `display_envelope` column on `messages` stores the append's display projection:

```ts
type StoredDisplayEnvelope = {
    kind: "ai-sdk-ui-messages";
    aiSdkMajor: 7;
    schemaVersion: 1;
    messages: ConversationUIMessage[];
};
```

The envelope carries both the AI SDK major and a harness display-schema version. The AI SDK version identifies the outer container; the harness version evolves the parts vocabulary and its upcasters independently.

The envelope rides the **first row of the append**, not "the genuine-user-start row". Those coincide for a conversation turn and diverge for a host-appended record, which opens its own append but does not open a turn. Keying on the append makes the invariant uniform, and it makes the read trivial: walk a thread's rows in `seq` order and concatenate the projections you meet. No join, no grouping pass, no special case. A tail retraction still removes each envelope with the row it describes, because the row it rides is inside the retracted range either way.

### D2 — The container is AI SDK; the parts vocabulary is ours

`UIMessage` supplies message identity, role, ordering, metadata, and `validateUIMessages`. Text rides as a text part. **Every other part rides as a typed `DataUIPart` whose payload is the Cortex display part minus its `type` discriminant.**

This includes tool calls, and that is the decision that matters. AI SDK's `dynamic-tool` part has a two-state terminal vocabulary (`output-available` / `output-error`) and no field for a call detail. A `CortexPart` tool call carries a **four-way** outcome — `ok`, `error`, `denied`, `incomplete` — and a one-line detail. Mapping through `dynamic-tool` silently drops the detail and flattens a user's denial into a failure, on every reload, forever. Both are exactly the defects that motivated the tool-call-detail work; reintroducing them inside the durable projection would be worse than never having fixed them, because storage is where a wrong value becomes permanent.

So a stored tool call is `data-tool-call` with `{toolCallId, toolName, outcome, detail?}`. Storage is then lossless in both directions and the read is a discriminant move rather than an interpretation. See D9 for why the outcome is one required field rather than a lifecycle plus an optional outcome.

Alternatives rejected:

- **`dynamic-tool` plus `toolMetadata: {outcome, detail}`.** Closer to AI SDK convention, but `state` and `toolMetadata.outcome` would both encode how the call ended — two representations of one terminal fact, and the impossible pairs that come with it. This is the same objection that made the loop's own event three-way instead of `isError` plus `denied` — and the same one D9 answers.
- **`dynamic-tool` with `approval-responded` for a denial.** AI SDK-native and semantically exact, but it demands an approval id the recorder does not always hold, and it asserts an AI SDK approval-flow semantics the harness does not actually implement.
- **Storing the tool input and re-deriving the detail on read.** That is reconstruction again — it needs the tool's current schema and its `describeCall` hook, so a schema change rewrites history. The detail is what was *shown*; it is display data, and display data is what this envelope is for.

### D3 — Persist complete messages, not only data parts

The recorder persists complete ordered messages. Text, tool parts, and card parts therefore retain their relative placement without anchors or reconstruction rules. Persisting only the data parts was rejected because concurrent tools and text-before/text-after-tool turns need extra placement metadata that the message already encodes.

### D4 — Record once at the conversation emission seam

A harness-owned recorder folds the top-level turn event sequence into display messages while forwarding every event unchanged to the live surface. The same recorder observes provider text deltas, tool lifecycle events, tool-emitted data parts, and approval-gateway parts; call sites must not construct an unrecorded parallel emit path.

The recorder:

- copies JSON data at receipt instead of retaining mutable emitter references;
- excludes sub-agent events that the top-level conversation does not display;
- persists only conversation data parts whose registry entry is non-transient;
- places every part through one `upsert`, so a tool call reaching `finished` and an `ask` reaching its terminal status are the same operation — latest-wins by stable id, in the position the part first took, so a late finish never reorders what the user watched appear;
- records each call's outcome and detail **as received**, never recomputed;
- returns the complete projection to the append.

**A call is recorded `incomplete` at dispatch and overwritten when it finishes.** The record is then honest at every instant, and a turn that ends mid-call needs no closing pass — the calls that never finished are already saying so. Stamping such a call `error` would report a failure the tool never returned, and `ok` a success nothing saw.

### D5 — One append signature, and records get a projection too

`appendTurn(threadId, turn)` takes one value carrying `modelMessages`, `displayMessages`, and `turnUsage`. There is no message-array overload and no positional rollup: an overload that omits the display projection is an append that stores a turn nobody can replay, and it would be the convenient one to reach for.

A host-appended record — an analysis run's outcome — has no live turn behind it, so no recorder produces its projection. `conversationRecordTurn(text)` builds both halves, and the harness owns the record-to-`system` mapping for the same reason it owns the synthetic marker: a hand-assembled one can be a message the turn-boundary predicates fail to recognise. Without this, a record would be stored, read by the model, and silently invisible in the transcript.

### D6 — The rollup stays in one place

The turn's reported usage rides the model row that ended the turn, in its own column, and the read folds it onto the assistant reply of the append it belongs to. It is deliberately NOT copied into the display projection: it is a fact about what the turn cost, not about what it displayed, and two durable copies of one fact can disagree. The fold survives a row that displays nothing, exactly as the interruption marker does.

### D7 — Migrate at startup, and leave reconstruction with no runtime caller

Startup scans appends whose envelope is null, renders each once through the migration renderer, and freezes the result. The renderer keeps everything reconstruction was good at — card resolution, outcome recovery from paired `tool-result` blocks, detail recovery from the persisted input — because for a legacy row that is genuinely the best available account, and it is strictly better than the model-derived text alone.

Recovering the detail needs the assembled conversation roster (embedder-contributed tools included), so the migration runs **after** `assembleCoreRuntime` and before any traffic; assembly registers workflows and builds the agent, and starts nothing.

Migration is idempotent and processed in bounded batches. Database faults and invalid stored envelopes block startup and identify the thread/turn. Missing thread metadata, workspace content, plans, runs, or previews are normal historical absence: the migration persists the cardless projection, marks the turn migrated, and continues.

**There is no runtime fallback.** A row reaching a transcript read with no projection is skipped. This is the point of the change, not an oversight: a fallback makes reconstruction permanent, because a row that failed to migrate then reads as though it had, and the divergence between what was shown and what is replayed becomes invisible. Skipping makes the gap observable. The resolvers also leave the embedder-facing barrel, so no host can wire them back into a read; the deep import paths remain, since the barrel is a curated front door and not a wall.

### D8 — The migration ran, then came out; tolerance moved to the read

The migration shipped and converted every legacy turn. Once it had, the only thing it still did each boot was re-validate rows it had already written — and that sweep is what made one part key fatal to a whole deployment. The first release to retire a key met a stored envelope still carrying it, refused the row, and crash-looped the process for every tenant: no request to fail, no user to tell, nothing serving. The defect was one part, in one turn, in one thread.

So the tolerance moved to where the blast radius matches the defect. `parseStoredDisplayEnvelope` drops a part whose key the vocabulary has retired, or whose payload no longer satisfies the schema behind its key, warns with the row identity, and returns the rest of the turn. That is what the sweep was really guarding against, handled per row, at the read that meets it, by the code that already has to understand the envelope. The part schemas also stop being `.strict()`: they validate rows this package wrote itself, so an unknown field can only mean the part shed one, and rejecting a row over that would make dropping an optional field a read-breaking change.

With nothing left for it to do, the migration and the renderer behind it are deleted. A row that still carries no projection is skipped, exactly as before. D7's actual holding — no reconstruction on a read path — survives and is now unconditional, there being no renderer left to reach for.

### D9 — The terminal state is one field, not a lifecycle plus an optional outcome

The stored payload carries a single required `outcome` of `ok | error | denied | incomplete`. It does NOT carry a `status: "started" | "finished"` beside an optional outcome, which is what an earlier draft of this design stored.

Two fields for one fact fails the same way `isError` plus a would-be `denied` failed. It admits pairs that mean nothing — `{finished, undefined}` — and, worse for a published contract, it leaves the meaning of `{started, undefined}` in each consumer's head. Nothing makes a second host agree with the first: one renders it as still running, another as `ok`, another as a failure, and no compiler catches the disagreement. That is host-side interpretation of a harness-owned fact, which is exactly what this whole capability exists to remove — it would have moved reconstruction out of the read path and put a smaller version of it back in every embedder.

One field ends it. A consumer switches on `outcome`, and a consumer that forgets `incomplete` fails to compile.

`ToolCallPart.outcome` stays optional on the wire type because a LIVE part legitimately has none while the call is in flight — but its absence then means exactly one thing, and a replayed part always carries a value. `status` is deleted rather than kept for the live case: it was redundant with `outcome === undefined`, and its only reader was one line in the CLI.

The live loop event keeps its three-way `ToolOutcome`. A `tool-finished` is never incomplete, so widening that union would let an event claim something it cannot be; `ToolCallOutcome` widens it only where a record needs the fourth state.

### D8 — Keep DBOS streams independent

Display envelopes cover only the conversation emitter/consumer family. DBOS continues to persist workflow/run lifecycle and step parts in its append-only stream. A persisted `data-run-card` remains a reference to a run; opening it may read the independent DBOS stream.

## Risks / Trade-offs

- **Two durable projections could drift** → Build both inside one turn orchestrator, commit them atomically, and test live-versus-reloaded parity per part family.
- **An emission path could bypass recording** → One recording emitter is the required source for provider streaming, tools, and approval; each producer family is tested.
- **Startup migration may be slow on large local histories** → Bounded batches, only null envelopes, idempotent retries.
- **Historical resources may no longer exist** → Persist the cardless projection and finish; absence is not a database failure.
- **`incomplete` is a state renderers did not previously meet** → It is a value of a field they already switch on, so an exhaustive switch makes the omission a compile error rather than a silent mis-render (D9).
- **Skipping an unmigrated row shows less than a fallback would** → Accepted, and preferred: less, honestly, beats a plausible reconstruction that cannot be told apart from the real thing (D7).
- **The parts vocabulary diverges from AI SDK's** → Accepted. The consumer is a host reading `CortexPart`, not an AI SDK UI; and the divergence exists precisely where AI SDK's vocabulary is lossy for us (D2).
- **Breaking the embedder surface** → `appendTurn`, the transcript read, and the removed resolvers all change together, in one release, with the `cli` catching up in its own change.

## Migration Plan

1. Add the nullable `display_envelope` column and the versioned envelope parser.
2. Introduce the recorder and the single-signature atomic append.
3. Run the idempotent migration during boot, after assembly and before traffic.
4. Point the transcript read at stored projections only, and remove the reconstruction exports.
5. Update the `cli` consumer in its own subsystem change against the published harness.

## Open Questions

None.
