# Emit a chat part when a report session starts

## Why

A web client reads the chat stream and the thread listing over HTTP. It does not see a tool result, thus it cannot see that a turn spawned a report session. Today such a client infers the spawn from the lifecycle of the turn: when a turn settles, it reads the thread listing again. That inference is fragile. A turn that fails before its first token settles on a path that the client does not watch, and the spawned session stays invisible until the next reload.

The transcript has the same gap on reload. A message on the wire carries no store `seq`, thus a remote client cannot place a session entry at its spawn point. The CLI joins `Thread.parentSeq` against the store rows in process, and a remote client has no such join.

One persisted chat part repairs both. A part in the stream tells the client that a session started, at the moment it started. The same part persists into the display projection of the turn, thus a reload shows the entry at the position of the spawn with no `seq` on the wire.

## What Changes

- `start_report_session` emits a `data-report-session-started` part through the emit sink of its tool context. The part carries `threadId` and `parentThreadId`. It rides the started arm only. The existing-session arm and each refusal emit nothing.
- The part joins the chat-part vocabulary: the contract interface, the Zod schema, the part registry, and the durable display projection. Its registry entry is `conversation` / `conversation` / not transient / not reconciling, thus the conversation display recorder persists it in position.
- The part is a placement record and a freshness signal only. The thread store is the authority for the session: its existence, its title, and its archived state. A consumer whose part names an archived or absent thread renders nothing for it.

## Capabilities

### Modified Capabilities

- `report-session-spawn`: the tool announces a started session as one durable chat part.

## Impact

Harness source:

- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/contracts/part-registry.ts`, `src/contracts/index.ts` — the part vocabulary.
- `src/memory/conversation-display-storage.ts` — the durable display key for the part.
- `src/tools/start-report-session.ts` — the emission on the started arm.

Consumers: the change is additive. The CLI stays unchanged, because its store-driven listing already covers the two edges in process. A reloaded transcript in the CLI shows the part as a tagged mention until the CLI adopts a renderer for it. A web host can adopt the part to replace its settle-edge inference.
