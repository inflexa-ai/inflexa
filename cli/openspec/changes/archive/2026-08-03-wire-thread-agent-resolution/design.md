# Design — wire the turn engine to the harness thread-agent resolver

## Context

The harness's `thread-agent-resolution` capability (merged as inflexa#298) moved agent selection behind `CoreRuntime.agents: ThreadAgentResolver`. `forThread(type)` returns the assembled singleton for a registered type and refuses an unregistered one on the `Result` channel (`UnregisteredThreadType`), and `prepareChatTurn`'s ok result now carries `threadType`, read from the row the ownership check already loads. `CoreRuntime.conversationAgent` no longer exists.

The CLI embedder still has the old shape at three seams: the runtime handle lifts `core.conversationAgent` (`src/modules/harness/runtime.ts:1072`, typed at `:153`), the shared turn engine takes that pre-lifted agent (`src/modules/harness/turn.ts:105`) and hands it to `runAgent` (`:244`), and both transports do the lifting (`src/modules/harness/chat.ts:264`, `src/tui/hooks/conversation.ts:1365`).

## Goals / Non-Goals

**Goals:**

- The turn engine runs the agent the harness resolves for the thread's type — the embedder half of inflexa#236.
- The unregistered-type refusal reaches the user as a rendered terminal outcome, never a throw and never a silent fallback to the conversation agent.
- Zero extra queries: the type rides the prepare result the engine already has.

**Non-Goals:**

- No Report Builder agent, no `report` thread creation path (inflexa#225).
- No change to how the conversation agent is assembled, its roster, or its model swap.
- No change to the harness itself — the CLI consumes the seam as merged.

## Decisions

**Resolve inside the engine, after prepare.** The thread's type is known only from `prepareChatTurn`'s ok result, so the engine — not the transport — resolves the agent, between the prepare branch handling and the `runAgent` call. The alternative, resolution at the call sites, needs a second thread read before the turn and re-scatters a selection the harness centralized; rejected.

**`RunChatTurnArgs` carries the resolver, not an agent.** `conversationAgent: AgentDefinition` becomes `agents: ThreadAgentResolver`. The transports lift `runtime.agents` exactly as they lifted the agent, so the engine stays decoupled from the whole runtime handle. The alternative — keep the field and add the resolver beside it — leaves a dead parameter and two sources for one decision; rejected.

**The refusal is a new terminal `TurnOutcome`, and it does not append.** `forThread` refusing yields `{ kind: "agent_unresolved", threadType }`. It is not `prepare_failed` (prepare succeeded; the operator guidance differs — the thread's type has no registered agent in this build) and not `thread_gone` (the thread exists and is owned). `appendTurn`'s contract is "every `runAgent`-reaching path"; this branch never reaches `runAgent`, so nothing persists — same stage and same persistence behavior as `prepare_failed`. The alternative — persist `[userMessage]` alone, the thrown-failure shape — was considered and rejected (user-confirmed): a thrown failure reached the loop and the message opened a real turn, while a refused type cannot run at all, and recording the message would strand it on a thread no registered agent can answer.

**Test fakes build resolver literals.** The barrel exports `ThreadAgentResolver` as a type only (`createThreadAgentResolver` stays internal to the harness), so fakes are one-method literals over neverthrow's `ok`/`err` — `{ forThread: () => ok(agent) }`. The widened prepare ok literal gains `threadType: "conversation"` in every fake. `runtime.test.ts:289`'s handle assertion moves to `runtime.agents.forThread("conversation")` with the test-only `_unsafeUnwrap()`.

**Rendering follows each transport's existing failure path.** The REPL prints the refusal where it prints `prepare_failed`; the TUI surfaces it through the same failed-turn notice path in `conversation.ts`. The message names the thread type; it does not tell the user to retry — retrying cannot succeed until a build registers the agent.

## Risks / Trade-offs

- [The pinned `@inflexa-ai/harness` 0.16.0 lacks the resolver, so the workspace must be on the linked working copy] → `bun run harness:local` before typecheck; the pin-bump commit is where CI goes green, which is the documented cross-subsystem shape (root `CLAUDE.md`).
- [A future typed thread reaching the CLI before its agent registers lands on the refusal outcome] → intended behavior: the outcome is explicit and rendered, not a fallback. The only thread type any CLI path creates today is `conversation`.
- [Fakes drifting from the real resolver's semantics (singleton identity)] → the engine treats the agent as opaque per turn; no CLI code depends on call-to-call identity.

## Migration Plan

Single commit inside `cli/`; no data, no config, no persisted-state migration. Rollback is a revert.

## Open Questions

_None._
