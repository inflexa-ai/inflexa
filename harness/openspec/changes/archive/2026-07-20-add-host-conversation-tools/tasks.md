## 1. Host-tool seam

- [x] 1.1 Add `hostTools?: readonly Tool[]` to `ConversationAgentDeps` (`src/agents/conversation-agent.ts`), documented as the embedder-contributed conversation-tool seam.
- [x] 1.2 Append `hostTools` (destructured, `?? []`) after the built-in roster in the `tools` literal (`conversation-agent.ts:259`), before the `AgentDefinition` return.
- [x] 1.3 Confirm `ConversationAssemblyDeps` (`src/runtime/assemble.ts:62`) carries `hostTools` through automatically (it is `Omit<ConversationAgentDeps, …3 fields>`, which retains `hostTools`); if not, thread it explicitly.
- [x] 1.4 Verify the public barrel already exports `Tool`, `defineTool`, and `ToolContext`; add nothing if present.

## 2. grantKey on the ask primitive

- [x] 2.1 Add optional `grantKey?: string` to `AskRequest` (`src/tools/approval/contract.ts`), with a doc comment stating it keys the standing grant when the granted class is broader than the displayed `command`, is generic (not domain-specific), and is never rendered.
- [x] 2.2 Add a `grant_key` column to the `cortex_asks` table schema (`src/state/init.ts`).
- [x] 2.3 Persist `grantKey ?? command` into `grant_key` at insert (`insertPendingAsk` and `insertGrantedAsk`, `src/tools/approval/queries.ts`).
- [x] 2.4 Change `answerAsk`'s `UPDATE … RETURNING` to return `grant_key`, and the `cortex_ask_grants` INSERT to use it (`queries.ts:159-181`).
- [x] 2.5 Change the grant short-circuit read to key off `grantKey ?? command`: `selectGrant(pool, ctx.analysisId, request.grantKey ?? request.command)` (`gateway.ts:82`) and the granted-audit path (`gateway.ts:83`).
- [x] 2.6 Confirm `emitAskPart` still emits `command` only — `grantKey` never enters the `data-ask` part (`gateway.ts:137-149`).

## 3. Tests

- [x] 3.1 Test: a `hostTools` entry appears in the conversation agent's tools alongside the built-ins; omitting `hostTools` yields exactly the built-in roster.
- [x] 3.2 Test: a host tool's `execute` receives a `ToolContext` carrying `ask`; off an interactive surface the ask is denied by `UnavailableAsk`.
- [x] 3.3 Test: an `always` reply with a `grantKey` records a grant under `grant_key`; a later ask with a *different* `command` but the *same* `grantKey` in the same analysis short-circuits without pausing.
- [x] 3.4 Test: an `always` reply with no `grantKey` keys the grant on `command` (byte-identical to the pre-change behavior); a grant does not cross analyses.
- [x] 3.5 Test: the `data-ask` part carries `command`, never `grantKey`.

## 4. Verify

- [x] 4.1 `tsc -p tsconfig.json` and `bun test` pass; run `bun run format:file` on changed `src/` files.
- [x] 4.2 `openspec validate add-host-conversation-tools --strict` passes.
