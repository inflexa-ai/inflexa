## Context

The conversation agent's tool roster is a closed hardcoded literal built inside `createConversationAgent` (`src/agents/conversation-agent.ts:185-259`); `ConversationAgentDeps` (`:100-159`) has no field that lets an embedder contribute a tool. The only tool-selection mechanism in the codebase, `per-agent-tool-allowlist`, is a *sandbox-agent* concern over a closed internal registry — it does not apply to the conversation agent and is not an embedder-contribution seam.

The `ctx.ask` primitive (`tool-approval` spec) carries a single `command` string on `AskRequest` (`src/tools/approval/contract.ts:21-25`) that does double duty: the surface renders it (`gateway.ts:144`) and it is the exact key an `always` standing grant matches on (`gateway.ts:82`, `queries.ts:166,175-177`). A tool that wants the prompt to show the exact command while granting a broader *class* cannot express that today.

The consumer driving both needs is the CLI's `run_inflexa` tool (issue #154, a separate `cli` change): it must be a conversation tool the harness never learns the meaning of, and its `always` grant must key on the resolved subcommand path (e.g. `inflexa refs download`) while the prompt shows the exact argv.

## Goals / Non-Goals

**Goals:**
- Let an embedder add conversation-agent tools without the harness learning anything domain-specific about them.
- Let a tool decouple the standing-grant key from the displayed command, backward-compatibly.
- Keep the change additive: no new transport, no new chat-part shape, no change to deny-by-default behavior.

**Non-Goals:**
- No embedder-contributed *sandbox* tools — the air gap and the closed `SandboxToolName` union stay as they are.
- No per-tool policy, allowlist, or registration surface in the harness — a host tool is just a `Tool` value; policy (which commands, what the grant key is) lives entirely in the embedder's tool.
- No change to how `once`/`always`/`reject` resolve, poll, or end the turn.

## Decisions

### Host tools are pre-built `Tool[]`, not a factory

`hostTools?: readonly Tool[]` on `ConversationAgentDeps`, threaded through `ConversationAssemblyDeps` (`src/runtime/assemble.ts:62`, the `Omit` of the three assembler-owned fields) and appended after the built-in roster at `conversation-agent.ts:259`.

A factory (`createHostTools(deps) => Tool[]`) was considered and rejected: everything a host tool needs at run time — `session`, `signal`, `emit`, `runStep`, `ask` — already arrives via `ToolContext` at call time, so there is no harness-side dependency to hand the embedder at construction. The embedder closes its own deps (spawn logic, argv classifier, dev/prod resolution) over the tool on its side. Pre-built `Tool[]` is the minimal seam.

Appending (built-ins, then host tools) keeps built-in ordering stable and makes a host tool purely additive. Name collisions are the embedder's responsibility; the harness does not police tool ids (it does not for built-ins either).

### `grantKey` is optional and defaults to `command`

`AskRequest.grantKey?: string`. The grant read (`gateway.ts:82`) and the `always` write (`queries.ts:175-177`) key off `grantKey ?? command`. Absent `grantKey`, behavior is byte-identical to today, so every existing caller and the shipped audit/lifecycle scenarios are unchanged.

`grantKey` is generic — an opaque key string, not a domain field — so it does not violate the primitive's "no tool- or domain-specific fields" invariant. The surface never renders it; it renders `command`.

### The grant key is persisted on the `cortex_asks` row

The `always` grant is written at answer time (`queries.ts:159-181`), which reads its key from the `cortex_asks` row via `UPDATE … RETURNING` — the answering path does not hold the original `AskRequest`. So `grantKey` must be persisted when the pending ask is inserted:
- add a `grant_key` column to `cortex_asks` (`src/state/init.ts`), written as `grantKey ?? command` at `insertPendingAsk`/`insertGrantedAsk`;
- `answerAsk`'s `RETURNING` returns `grant_key`; the `cortex_ask_grants` INSERT uses it;
- the short-circuit `selectGrant` compares against `grantKey ?? command`.

`cortex_ask_grants` keeps its `(analysis_id, command)` column shape; the value stored in `command` is now the grant key. Renaming that column was considered and rejected as churn for no behavioral gain — the grants table is analysis-lifecycle-scoped and never displayed.

### The `data-ask` chat part is unchanged

The part is answered by `id` and displays `command`; `grantKey` is internal to the grant machinery. No change to `chat-parts.ts`, its schema, or the part registry — smaller blast radius and no consumer-visible contract change.

## Risks / Trade-offs

- **[A broad `grantKey` grants more than the displayed `command`.]** → The spec makes it the tool's responsibility to render the breadth of what an `always` blesses in the request content; the harness cannot enforce this because it is agnostic to the tool. The CLI consumer surfaces the class explicitly in its prompt copy. This is the deliberate cost of decoupling show from grant.
- **[A host tool could call `ctx.ask` off an interactive surface and hang.]** → It cannot: unwired `ask` resolves to the deny-by-default `UnavailableAsk`, so the ask is denied, not left waiting. Host tools inherit this for free.
- **[Schema migration on a table that landed last release.]** → Adding a nullable/`DEFAULT`-backed `grant_key` column is additive; existing pending rows (if any survive a restart) are swept to `expired` at boot regardless, so no backfill of live state is required.
- **[A host tool gains a capability a built-in lacks.]** → It does not: it runs through the same dispatch, error contract, and `ToolContext` as a built-in, and is never added to a sandbox agent. The seam grants roster membership, nothing more.
