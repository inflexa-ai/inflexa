# Proposal: add-thread-agent-resolution

## Why

PR #292 gave every thread a `threadType` precisely so the type can select the agent that runs it, but nothing reads the type on the turn path: the harness assembles exactly one agent, exposes it as `CoreRuntime.conversationAgent` (`src/runtime/assemble.ts:90`), and the embedder hardcodes that one agent into every turn. The selection rule must be harness-owned — a managed deployment must get the same type→agent behavior with zero embedder involvement — and the Report Builder (#225) needs a registration point that is not "rewire the CLI".

## What Changes

- `assembleCoreRuntime` builds a type-keyed registry of the agents it assembles — one entry today, `conversation` → the conversation agent — and returns a resolution surface on `CoreRuntime` (`agents.forThread(type)`).
- Resolution is total over registered types and refuses unregistered ones with a typed error on the `Result` channel. `report` is a valid `ThreadType` with no registered agent until #225 registers the Report Builder at this same point; the refusal path is typed now even though no code creates `report` threads yet.
- The registry holds the assembled singleton `AgentDefinition`s, never per-call factories — resolution returns the same object assembly built, so construction-time captures (an embedder's swappable provider handles, closure-wired tools) stay valid across every turn.
- `prepareChatTurn`'s `ok` result gains `threadType`, read from the thread row the ownership check already loads (`src/app/chat-turn.ts:57`) — zero extra queries. A turn's caller resolves the agent from that value instead of receiving one from configuration.
- **BREAKING**: `CoreRuntime.conversationAgent` is removed; consumers reach agents only through the resolution surface. The boot backfill (`src/runtime/boot.ts:108`) reads the conversation roster through it.
- The new resolution types are re-exported from the package barrel.

## Capabilities

### New Capabilities

- `thread-agent-resolution`: how a thread's type selects the agent that runs its turns — the registry built at assembly, the resolution surface on `CoreRuntime`, singleton semantics, the typed refusal for an unregistered type, and `prepareChatTurn` surfacing the thread's type.

### Modified Capabilities

- `harness-durable-runtime`: the composition-root requirement changes — `assembleCoreRuntime` builds the type-keyed agent registry over the conversation agent it constructs, and `CoreRuntime` exposes the resolution surface instead of a bare `conversationAgent` field.

## Impact

- **Code**: `src/runtime/assemble.ts` (registry + `CoreRuntime` shape), `src/runtime/boot.ts` (backfill call site), `src/app/chat-turn.ts` (result type), `src/index.ts` (barrel exports), plus tests beside each.
- **API (breaking)**: `CoreRuntime.conversationAgent` disappears from the package surface; `PrepareChatTurnResult`'s `ok` variant widens by one required field. Rides the same unpublished breaking release as #292's `Thread` changes.
- **Embedder**: the CLI turn engine stops receiving a hardcoded agent and resolves per turn from `prepared.threadType`; that wiring is CLI-side work adopted at the harness pin bump, outside this change.
- **Not touched**: `parent_thread_id`/`parent_seq` (selection is type-only), the Report Builder agent and its tool-binding redesign (#225), message assembly per type (#225 decides what a report turn assembles).
