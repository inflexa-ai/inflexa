# Tasks: add-thread-agent-resolution

## 1. Resolution surface

- [x] 1.1 Define the resolution types in `src/runtime/assemble.ts`: the resolver shape (`agents.forThread(type): Result<AgentDefinition, UnregisteredThreadType>`) and the `unregistered_thread_type` error variant (`DomainError`-conventioned, carries the refused `threadType`). Synchronous `Result`, not `ResultAsync`.
- [x] 1.2 Build the `Partial<Record<ThreadType, AgentDefinition>>` registry inside `assembleCoreRuntime` (entry: `conversation` → the assembled conversation agent) and replace `CoreRuntime.conversationAgent` with the `agents` resolution surface.
- [x] 1.3 Update every in-harness reader of `CoreRuntime.conversationAgent` — the boot backfill at `src/runtime/boot.ts:108` resolves `conversation` through the registry (unreachable-err bridge justified: assembly registers `conversation` unconditionally) — and sweep `src/` + tests for remaining readers.
- [x] 1.4 Tests beside `assemble.ts`: `forThread("conversation")` returns ok with the assembled agent; two calls return the identical object; `forThread("report")` returns the `unregistered_thread_type` error (direct drive — the path is dead in production until #225).

## 2. prepareChatTurn surfaces the type

- [x] 2.1 Add required `threadType: ThreadType` to `PrepareChatTurnResult`'s `ok` variant in `src/app/chat-turn.ts` — existing thread: the loaded row's type; created thread: `conversation`.
- [x] 2.2 Extend the chat-turn tests: an existing `conversation` thread reports its stored type; a first-turn create reports `conversation`; a store-written `report` row reports `report`.

## 3. Package surface

- [x] 3.1 Re-export the resolver surface types and the error type from `src/index.ts`; remove any barrel mention of the deleted `conversationAgent` field.

## 4. Verify

- [x] 4.1 `tsc -p tsconfig.json` — exit 0.
- [x] 4.2 Targeted `bun test` over the changed areas only (assemble/boot, chat-turn) with `CORTEX_TEST_PG_URL` set — never the full suite.
- [x] 4.3 `bun run format:file` on every changed file under `src/`.
