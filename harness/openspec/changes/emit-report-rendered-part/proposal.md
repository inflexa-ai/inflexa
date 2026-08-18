# Emit a chat part when a report preview renders, and generalize the spawn part

## Why

The report-session path emits no chat data part. A web client that watches the chat stream cannot see that a preview rendered a fresh page mid-turn: it learns of the render only when the turn settles and it reads the version surfaces again. The transcript of the child thread has the same gap on reload — nothing places a "report updated" entry inside the turn, at the point where the render ran.

One persisted chat part repairs both. A part in the stream tells the client that a fresh page exists, at the moment it lands. The same part persists into the display projection of the turn, thus a reload shows the entry at the position of the render.

The spawn part has a naming problem of its own. `data-report-session-started` binds the parent→child session mechanic to one thread type, and the mechanic is reusable: a report session is the first child-session type, not the only one. Nothing is deployed, thus the rename costs nothing now and a lock-in later.

## What Changes

- `preview_report` emits a `data-report-rendered` part through the emit sink of its tool context. The part carries an `id` unique to the emission, the `renderedAt` ISO timestamp of the render, and the `title` of the rendered document. It rides the `rendered` arm only. Every degraded arm emits nothing.
- The part joins the chat-part vocabulary: the contract interface, the Zod schema, the part registry, and the durable display projection. Its registry entry is `conversation` / `conversation` / not transient / not reconciling, thus the conversation display recorder persists it in position.
- The part is a placement record and a freshness signal only. The version store and the session-page mint stay the authority for what is viewable: the part carries no path, no format field, no version internals, and no minted URL.
- `data-report-session-started` renames to `data-child-session-started`, and the payload gains `threadType` — the type of the child thread in the thread store's vocabulary (`"report"` today). The contract type renames to `ChildSessionStartedPart`, the durable display key to `child-session-started`, and `start_report_session` emits the new type with `threadType: "report"`. The authority rule stays: the part places and signals, and the thread store decides what exists.

## Capabilities

### Modified Capabilities

- `report-session-agent`: the preview announces a rendered page as one durable chat part.
- `report-session-spawn`: the spawn announcement generalizes to the child-session vocabulary.

## Impact

Harness source:

- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/contracts/part-registry.ts`, `src/contracts/index.ts`, `src/contracts/message.ts` — the part vocabulary.
- `src/memory/conversation-display-storage.ts` — the durable display keys for both parts.
- `src/tools/report-session/preview-report.ts` — the emission on the rendered arm.
- `src/tools/start-report-session.ts` — the spawn emission under the new type.

Consumers: the rendered part is additive; a host that ignores it loses nothing. The rename ships before any deployment, thus no reader holds the old literal in durable state that matters — a stored `report-session-started` display key renders nothing, and that loss is accepted. The CLI compiles against the published 0.23.0 and keeps the old literal until it adopts the 0.24.0 release.
