# Tasks — wire the turn engine to the harness thread-agent resolver

## 1. Workspace

- [x] 1.1 Link the working-copy harness (`bun run harness:local`) so `ThreadAgentResolver`, `UnregisteredThreadType`, `ThreadType`, and `CoreRuntime.agents` resolve; confirm `bun run typecheck` fails only at the seams this change rewires. (Observed: the seams, plus seven fixture files broken by the widened `Thread` shape — captured as task 5.4.)

## 2. Runtime handle

- [x] 2.1 In `src/modules/harness/runtime.ts`, replace `HarnessRuntime.conversationAgent: AgentDefinition` with `agents: ThreadAgentResolver`; rewrite the field's JSDoc for the resolver (type-keyed, refusal on the `Result` channel), and lift `core.agents` at the construction site.

## 3. Turn engine

- [x] 3.1 In `src/modules/harness/turn.ts`, replace `RunChatTurnArgs.conversationAgent` with `agents: ThreadAgentResolver` and update the args JSDoc.
- [x] 3.2 Add the resolution step between the prepare branches and `seams.run`: `agents.forThread(prepared.threadType)`; on refusal return the new terminal outcome before any `runAgent` or `appendTurn` work.
- [x] 3.3 Add the `TurnOutcome` branch for the refusal (carries the refused `ThreadType`), documented as distinct from `prepare_failed`, with the same no-append stage.

## 4. Transports

- [x] 4.1 In `src/modules/harness/chat.ts`, pass `runtime.agents` and print the refusal outcome to stderr where `prepare_failed` prints, naming the thread type.
- [x] 4.2 In `src/tui/hooks/conversation.ts`, pass `runtime.agents`; on the refusal outcome, raise the error banner naming the thread type and call `setLastTurnFailure` with the outcome's refusal object — the structured stand-in pattern `thread_gone` uses (`conversation.ts:901`), since the signal is `unknown`-typed.

## 5. Tests

- [x] 5.1 Update every prepare-ok fake literal with the required `threadType` field, and every fake that supplied `conversationAgent` with a one-method resolver literal (`{ forThread: () => ok(agent) }`). The closed file list (grep `prepareChatTurn|conversationAgent` over tests): `src/modules/harness/turn.test.ts`, `runtime.test.ts`, `agent_switch.test.ts`, `usage_ledger.test.ts`; `src/tui/hooks/conversation.test.ts`, `conversation.interrupt_retract.test.ts`, `conversation.usage_recorder.test.ts`, `conversation.render.test.tsx`, `run_completion.test.ts`; `src/tui/plan_steps_command.test.tsx`.
- [x] 5.2 Move the handle assertion in `runtime.test.ts` to `runtime.agents.forThread("conversation")` (`_unsafeUnwrap()` is test-legal).
- [x] 5.3 Add the refusal-branch test in `turn.test.ts`: a resolver that refuses yields the new outcome, `seams.run` is never called, nothing is appended.
- [x] 5.4 Pin-jump fallout, not this change's seams: the working-copy harness requires `threadType`/`parentThreadId`/`parentSeq` on `Thread`. Update the fixture literals in `src/modules/harness/chat.test.ts`, `src/tui/commands.test.ts`, `src/tui/hooks/thread.test.ts`, `src/tui/layout/sidebar.render.test.tsx`, `src/tui/session_delete_dialog.render.test.tsx`, `src/tui/session_remove_dialog.render.test.tsx`, `src/tui/session_restore_dialog.render.test.tsx` (defaults: `"conversation"`, `null`, `null`).

## 6. Verify

- [x] 6.1 `bun run format:file` on the changed `src/` files; `bun run typecheck`; `bun run lint`.
- [x] 6.2 Run the touched test files only (`bun run test src/modules/harness/turn.test.ts …` — never the full suite): all pass.
