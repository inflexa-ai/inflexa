# Wire the turn engine to the harness thread-agent resolver

## Why

The harness now owns type→agent selection: `assembleCoreRuntime` builds a type-keyed registry and exposes it as `CoreRuntime.agents` (`forThread(type)`), and `prepareChatTurn`'s ok result carries the thread's `threadType`. The removed `CoreRuntime.conversationAgent` field is exactly what the CLI still lifts onto its runtime handle and hardcodes into every chat turn, so the embedder both fails to compile against the new harness surface and would run the wrong agent on any thread whose type is not `conversation`. This is the embedder half of inflexa#236 (the harness half merged as inflexa#298).

## What Changes

- `HarnessRuntime.conversationAgent` (the CLI runtime handle) is replaced by `agents: ThreadAgentResolver`, lifted from `core.agents` at the composition root (`src/modules/harness/runtime.ts`).
- The shared turn engine (`src/modules/harness/turn.ts`) stops taking a pre-lifted `conversationAgent: AgentDefinition` and instead takes the resolver. It resolves the agent **after** `prepareChatTurn` succeeds, from the `threadType` the ok result carries — the type is unknowable before prepare.
- The resolver's refusal (`unregistered_thread_type`, a `Result` error, never a throw) becomes a new terminal `TurnOutcome` branch, distinct from `prepare_failed`: preparation succeeded; the thread's type has no registered agent. No `runAgent` call and no `appendTurn` happen on this branch.
- Both transports pass the resolver instead of the lifted agent: the dev REPL (`src/modules/harness/chat.ts`) and the TUI conversation hook (`src/tui/hooks/conversation.ts`).
- Seam fakes in the turn-engine tests supply the widened required `threadType` field on the prepare ok literal; a new test drives the refusal branch.

## Capabilities

### New Capabilities

_None. The selection rule is harness-owned (`thread-agent-resolution` in `harness/openspec/specs`); this change is embedder wiring of that seam._

### Modified Capabilities

- `chat-command`: the turn-loop requirement changes from "`runAgent` with the assembled conversation agent" to "`runAgent` with the agent the harness resolves for the thread's type", plus the refusal outcome.
- `tui-harness-chat`: the shared-turn-engine requirement gains the same resolution step and the unregistered-type terminal outcome.
- `harness-runtime`: the barrel-import requirement's enumeration extends with the thread-agent resolution surface (`ThreadAgentResolver`, `UnregisteredThreadType`, `ThreadType`).

## Impact

- `src/modules/harness/runtime.ts` — handle field swap at the composition root.
- `src/modules/harness/turn.ts` — the resolution step, the new outcome branch, the args type.
- `src/modules/harness/chat.ts`, `src/tui/hooks/conversation.ts` — call-site wiring plus rendering the new outcome.
- Tests: `turn.test.ts` (fakes + refusal branch), `runtime.test.ts`, `agent_switch.test.ts`, `usage_ledger.test.ts` (widened prepare literals / handle field).
- Dependency: compiles only against a harness build that exports the resolver. The pinned registry snapshot (`@inflexa-ai/harness` 0.16.0) predates it; the working copy has it (`bun run harness:local`).
