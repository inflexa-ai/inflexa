# Emit a chat part when a report preview renders

## Why

The report-session path emits no chat data part. A web client that watches the chat stream cannot see that a preview rendered a fresh page mid-turn: it learns of the render only when the turn settles and it reads the version surfaces again. The transcript of the child thread has the same gap on reload — nothing places a "report updated" entry inside the turn, at the point where the render ran.

One persisted chat part repairs both. A part in the stream tells the client that a fresh page exists, at the moment it lands. The same part persists into the display projection of the turn, thus a reload shows the entry at the position of the render.

## What Changes

- `preview_report` emits a `data-report-rendered` part through the emit sink of its tool context. The part carries an `id` unique to the emission, the `renderedAt` ISO timestamp of the render, and the `title` of the rendered document. It rides the `rendered` arm only. Every degraded arm emits nothing.
- The part joins the chat-part vocabulary: the contract interface, the Zod schema, the part registry, and the durable display projection. Its registry entry is `conversation` / `conversation` / not transient / not reconciling, thus the conversation display recorder persists it in position.
- The part is a placement record and a freshness signal only. The version store and the session-page mint stay the authority for what is viewable: the part carries no path, no format field, no version internals, and no minted URL.

## Capabilities

### Modified Capabilities

- `report-session-agent`: the preview announces a rendered page as one durable chat part.

## Impact

Harness source:

- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/contracts/part-registry.ts`, `src/contracts/index.ts` — the part vocabulary.
- `src/memory/conversation-display-storage.ts` — the durable display key for the part.
- `src/tools/report-session/preview-report.ts` — the emission on the rendered arm.

Consumers: the change is additive. A host adopts the part for mid-turn freshness and for the inline entry; a host that ignores it loses nothing.
