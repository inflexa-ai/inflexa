## Why

An embedder cannot contribute a conversation-agent tool today: the tool roster in `createConversationAgent` is a closed hardcoded literal, and `ConversationAgentDeps` carries no injection point. The CLI needs to expose its own `inflexa` CLI as an agent tool (issue #154) without teaching the harness what `inflexa` is — the boundary rule in the root guidance is "design new capabilities harness-first, then wire them from the embedder." Separately, that tool wants an approval whose standing grant is a *broader class* than the exact command shown, which the `ctx.ask` primitive cannot express: its `command` string is both what the user sees and the exact standing-grant key.

## What Changes

- Add a generic `hostTools?: readonly Tool[]` seam on `ConversationAgentDeps` (threaded through `ConversationAssemblyDeps`), appended after the built-in conversation-tool roster. The harness stays agnostic to what a host tool does; a host tool is an ordinary `defineTool` result and receives the same `ToolContext` (including `ask`) as every built-in.
- Add an optional `grantKey?: string` to `AskRequest`. When present, an `always` reply records the standing grant under `grantKey` while the prompt still displays `command`; when absent, the grant keys on `command` exactly as today (backward compatible). This lets a tool show the exact command that will run while granting a broader class.
- No new deny-by-default behavior, transport, or chat-part shape: `hostTools` reuses the existing tool dispatch, and `grantKey` reuses the existing `cortex_asks`/`cortex_ask_grants` ledger with one added column.

## Capabilities

### New Capabilities
- `host-conversation-tools`: the embedder-contributed conversation-tool seam — how a host supplies additional `Tool`s to the conversation agent, how they are appended to the built-in roster, and the invariant that the harness treats them identically to built-ins and learns nothing domain-specific about them.

### Modified Capabilities
- `tool-approval`: `AskRequest` gains an optional `grantKey` that decouples the standing-grant key from the displayed `command`; the `always` grant read/write key off `grantKey` when present, defaulting to `command`.

## Impact

- `harness/src/agents/conversation-agent.ts` — `ConversationAgentDeps.hostTools`, appended to the `tools` literal.
- `harness/src/runtime/assemble.ts` — `ConversationAssemblyDeps` carries `hostTools` through to `createConversationAgent`.
- `harness/src/tools/approval/contract.ts` — `AskRequest.grantKey?`.
- `harness/src/tools/approval/gateway.ts`, `queries.ts` — grant short-circuit and `always` write key off `grantKey ?? command`; `cortex_asks` gains a `grant_key` column persisted at insert and returned by the answer update.
- `harness/src/state/init.ts` — the `cortex_asks` schema.
- Public barrel already exports `Tool`, `defineTool`, `ToolContext`, and the approval types, so no export surface changes for the embedder.
- Consumer: the CLI's `run_inflexa` tool (a separate `cli` change) is the first host tool and the first `grantKey` caller.
