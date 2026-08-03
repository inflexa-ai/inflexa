# Design: add-thread-agent-resolution

## Context

`assembleCoreRuntime` builds exactly one agent and returns it as `CoreRuntime.conversationAgent` (`src/runtime/assemble.ts:103-111`). Two consumers hold that field: the boot-time display backfill, which needs the conversation tool roster (`src/runtime/boot.ts:108`), and the embedder, which passes the field into every turn's `runAgent`. `prepareChatTurn` loads the thread row for its ownership check (`src/app/chat-turn.ts:57`) and discards `threadType`. The type itself landed in #292: a closed two-member set, `conversation` and `report` (`src/memory/thread-store.ts:66-67`), closed precisely because type→agent selection must be exhaustive over a known membership.

Constraints from the surrounding system:

- An embedder may wrap providers in delegating handles it re-points at idle (the CLI's live model switch). Assembled tools capture those handles at construction (`src/agents/conversation-agent.ts:283`), so agent identity must be stable across turns.
- The current report-builder constructs its roster per invocation with closure-bound state (`src/execution/report-runner.ts:196`) — the shape this seam deliberately does not accommodate.
- The harness error channel is neverthrow `Result`; store-refused inputs are `DomainError` unions with a string `type` discriminator (`ThreadInputError`, `src/memory/thread-store.ts:135`).

## Goals / Non-Goals

**Goals:**

- The harness owns the type→agent selection rule; an embedder plumbs a value and never maps.
- One registration point, at assembly, where #225's Report Builder plugs in without touching any embedder.
- The turn path learns the thread's type at zero extra query cost.

**Non-Goals:**

- The Report Builder agent, its roster, and its tool-binding redesign (#225).
- Type-dependent message assembly — what a `report` turn's `prepareChatTurn` should assemble is #225's decision; this seam selects the agent only.
- Parent/child semantics (`parentThreadId`/`parentSeq` are not read here).
- Any embedder wiring (the CLI turn engine adopts at the pin bump).

## Decisions

### D1: The registry holds assembled singletons, never per-call factories

The registry is a `Partial<Record<ThreadType, AgentDefinition>>` built inside `assembleCoreRuntime`, next to `createConversationAgent`. Resolution returns the same object assembly built, every call.

The resolver wrapping is a small pure exported function (`createThreadAgentResolver`) rather than an inline closure: `DBOS.registerWorkflow` refuses duplicate names and any post-launch registration, so `assembleCoreRuntime` is single-shot per process and untestable as an offline unit — the pure function is what the resolver tests drive, while the registry literal stays inline in `assembleCoreRuntime` under tsc's eye.

*Alternative rejected — factory shape `forThread(type, ctx) => AgentDefinition`.* It would let #225 keep the report-runner's construction-time closures, but it rebuilds the roster per turn: new tool identities the boot backfill cannot enumerate and, in the CLI, orphaned swappable-provider captures. Issue #236 names the consequence as intended: registering at assembly forces the report tools to read their per-thread state from `ToolContext.session` at call time.

### D2: Partial today, typed refusal for the unregistered type

`report` is a valid `ThreadType` with no agent until #225 registers one. Resolution returns `Result<AgentDefinition, UnregisteredThreadType>` where the error is a `DomainError`-conventioned variant: `{ type: "unregistered_thread_type"; threadType: ThreadType }`. Resolution is synchronous (a record lookup), so the channel is plain `Result`, not `ResultAsync`.

*Alternative rejected — total record with a stub `report` agent that refuses at run time.* Same observable behavior, more code, and the stub would masquerade as a registered agent in any roster enumeration.

*Alternative rejected — land this change after #225 so the record is total from birth.* #236 is the registration point #225 plugs into; the dependency runs the other way.

The error channel is permanent, not interim scaffolding. When #225 registers `report` the record becomes total for today's membership, but `forThread` keeps the `Result` signature: `ThreadType` grows over the product's life, and a bare-`AgentDefinition` signature would force every future type to register its agent in the same commit that adds the type — re-coupling exactly what this seam decouples. A stable public signature across #225 also spares one more breaking surface change.

The refusal path is unreachable today — nothing creates `report` threads — so a unit test drives it directly against the resolver.

### D3: `prepareChatTurn` returns the type; `CoreRuntime` resolves

`PrepareChatTurnResult`'s `ok` variant gains a required `threadType: ThreadType`. Both branches already know it: an existing thread carries it on the loaded row, and an absent thread is created as `conversation` (the store default). The caller then resolves via `CoreRuntime.agents.forThread(threadType)`.

*Alternative rejected — hand the registry into `prepareChatTurn` and return the resolved agent.* It couples a deliberately dep-light prep function (`{ pool, logger }`) to agent resolution. The look-ahead cuts the other way, though: when #225 makes assembly itself type-dependent, the type switch belongs inside the harness prepare path — the resolution surface introduced here is the seam it will grow behind, which is why the new spec is named `thread-agent-resolution`, not `conversation-agent-resolution`.

### D4: `CoreRuntime.conversationAgent` is removed, not deprecated beside the registry

`CoreRuntime` becomes `{ agents, workflows }` with `agents.forThread(type)`. The boot backfill resolves `conversation` explicitly — correct by construction, since legacy display envelopes predate `report` threads. Keeping both surfaces would leave two ways to reach the same agent and invite drift; the unpublished release already carries #292's breaking `Thread` changes, so this rides at zero extra release cost.

## Risks / Trade-offs

- [A future `report` thread reaching `prepareChatTurn` assembles conversation-shaped context before the refusal] → the refusal fires before `runAgent`, so the wasted assembly is the whole cost; #225 owns assembly redesign.
- [The `unregistered_thread_type` refusal is dead code until #225] → direct unit test on the resolver; the type-level `Partial` keeps the compiler honest at the registration site.
- [Embedders on the published harness break at the pin bump] → expected cross-subsystem shape (root `CLAUDE.md`); the barrel exports the new types so the fix is mechanical.

## Open Questions

None. The error-channel question raised during exploration is decided in D2: the `Result` channel is permanent.
