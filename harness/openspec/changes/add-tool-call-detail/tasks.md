## 1. The hook on the tool primitive

- [x] 1.1 Add the optional `describeCall(input: z.infer<Schema>) => string` field to `ToolDefinition` in `src/tools/define-tool.ts`, and carry it onto the packaged `Tool`. Document why it is the call-time counterpart of `description`.
- [x] 1.2 Confirm the emitted AI SDK definition is unchanged — `createRegistry`'s `definitions()` must not send the hook to the model.
- [x] 1.3 Unit-test construction with and without the hook, including that a hook reading a field absent from the schema fails to typecheck (a type-level test or a documented `@ts-expect-error` fixture).

## 2. Normalization and computation

- [x] 2.1 Add a `normalizeDetail(raw: unknown) => string | undefined` helper beside the loop's emit sites: reject a non-string and an empty string, collapse to one line, strip control characters, apply the existing harness secret redaction, then cap at 120 characters.
- [x] 2.2 Add a `computeDetail(tool, rawInput, log)` guard that runs `tool.inputSchema.safeParse` first, calls the hook only on success, wraps the call in `try`/`catch`, logs a hook failure at `debug`, and returns `undefined` on any non-success path.
- [x] 2.3 Unit-test 2.1 and 2.2 in isolation: multi-line input, over-long input, a secret-bearing string, a throwing hook, a hook returning a non-string, and an input that fails validation.

## 3. Loop events

- [x] 3.1 Add `detail?: string` to the `tool-started` and `tool-finished` members of `EmitEvent` in `src/loop/types.ts`.
- [x] 3.2 Replace `isError: boolean` with `outcome: "ok" | "error" | "denied"` on `tool-finished`, and derive it from the tool result's output type in `src/loop/run-agent.ts` (`execution-denied` → `denied`; `error-text` / `error-json` → `error`; otherwise `ok`).
- [x] 3.3 Stamp the detail at both `tool-started` emit sites in `run-agent.ts` (the truncation-recovery path at the earlier site, and the normal tool-calls path), and carry the same computed value onto the matching `tool-finished`.
- [x] 3.4 Test the loop's emitted sequence for: a described call, an undescribed call, a denied call, a thrown failure, and a rejected input.

## 4. Wire contracts

- [x] 4.1 Add `detail?: string` to `ToolStartedEvent` and `ToolFinishedEvent`, and replace `isError` with the three-way `outcome`, in `src/contracts/chat-events.ts`.
- [x] 4.2 Mirror both changes in `src/contracts/schemas/chat-events.ts`, and unit-test the Zod schemas directly — these types have no in-repo consumer, so the schema tests are their only guard.
- [x] 4.3 Add `detail?: string` to `ToolCallPart` in `src/contracts/message.ts` and carry the outcome in place of `isError`.

## 5. The shared resolver

- [x] 5.1 Add `createDetailResolver(tools: readonly Tool[]) => (toolName: string, input: unknown) => string | undefined` in `src/tools/`, reusing `computeDetail` so live and reload paths cannot drift.
- [x] 5.2 Keep it off the embedder-facing barrel: its callers are the live activity surfaces and the startup migration, both internal.
- [x] 5.3 Test: a described tool resolves, a hookless tool yields `undefined`, an unknown tool name yields `undefined`, and a malformed persisted input yields `undefined`.

## 6. Startup migration of legacy turns

- [x] 6.1 Change `contentToCortexMessages` — the migration renderer — to take its resolvers as one options object (`{ resolveCard?, resolveDetail? }`) instead of a growing positional list.
- [x] 6.2 Index each row's `tool-result` blocks by `toolCallId` and derive the outcome from `output.type` in `genericToolCall`, using the same classification as task 3.2. A call with no paired result reports `ok`.
- [x] 6.3 Apply `resolveDetail` when building a generic tool-call part.
- [x] 6.4 Test: a migrated failed call reports the error, a migrated denied call reports the denial, a call with no paired result reports `ok`, a supplied resolver rebuilds the detail, and conversion without a resolver is otherwise unchanged.

## 7. Fold in the existing name-keyed formatter

- [x] 7.1 Rewrite `activityForTool` in `src/sandbox/sandbox-step-translate.ts` to resolve through a supplied resolver, keeping the tool-name fallback for a hookless tool. Delete the `TOOL_ACTIVITY` table and `activityFileName`.
- [x] 7.2 Thread the sandbox agent's own tool list to the call site in `src/workflows/sandbox-step.ts`.
- [x] 7.3 Thread the profiler agent's tool list through `ProfileActivityEmitter.forTool` in `src/tasks/data-profile-activity.ts`.
- [x] 7.4 Update `src/sandbox/sandbox-step-translate.test.ts` to cover the hook path and the fallback.

## 8. First hook coverage

- [x] 8.1 `update_working_memory` — the section and operation, plus the entry id when retiring or revising.
- [x] 8.2 `workspace_search` — the query.
- [x] 8.3 `read_file` — the path, plus the head or tail range when set.
- [x] 8.4 `inspect_run` — the run id, or the list page when no run id is given.
- [x] 8.5 `pubmed` — the action, plus the query, the pmids count, or the pmcId as the action selects.
- [x] 8.6 `search_gene` — the symbols.
- [x] 8.7 `execute_analysis` — the mode and the plan id.
- [x] 8.8 Sandbox mutate tools (`write_file`, `edit_file`, `execute_command`) — the path, or the script-like token from the argv. These feed the activity line, not a chat chip; they replace what `activityFileName` did in task 7.1.
- [x] 8.9 Workspace read tools that the deleted `activityFileName` covered generically (`grep`, `list_files`) — the pattern and the tree, and the directory. That helper appended the base name of ANY input carrying a `path`, so these two already showed a file name on the activity line; without a hook they are the one group this change would make strictly less informative.
- [x] 8.10 One test per hook asserting the exact string for a representative input.

## 9. Verify

- [x] 9.1 Run `bun run format:file` on every changed file under `src/`.
- [x] 9.2 Run `tsc -p tsconfig.json` and `bun test`.
- [x] 9.3 Update `CONTEXT.md` and `README.md` where they describe the tool primitive or the tool event vocabulary.
- [x] 9.4 Record in the change that the `cli/` consumption — the continuation-row layout, the design gallery state, the resolver wiring at `HarnessRuntime.conversationAgent.tools`, and the `outcome` migration in `conversation.ts` and `chat_printer.ts` — is a separate change in `cli/`.
