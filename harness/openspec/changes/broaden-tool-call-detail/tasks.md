## 1. Require the describeCall decision

Steps 1.1–1.3 are one atomic change: the package does not compile between them.

- [x] 1.1 In `src/tools/define-tool.ts`, make `ToolDefinition.describeCall` required and widen it to `((input: z.infer<Schema>) => string) | "none"`. Leave `Tool.describeCall` exactly as it is — an optional function.
- [x] 1.2 Change the packaging branch to key off `typeof def.describeCall === "function"` rather than an `undefined` check, so `"none"` is consumed at construction and never lands on the packaged tool.
- [x] 1.3 Sweep every `defineTool` site in `src/` that is not covered by group 2 or 3 and add `describeCall: "none"` — roughly 40 sites across `tools/bio/` (15), `tools/report/` (8), `tools/research/` (7, including the two non-`generate_plan` sites in `generate-plan.ts`), `tools/sandbox/` (3), `tools/workspace/file-stat.ts`, `tools/iterate-report.ts` (2), `execution/run-synthesis.ts` (2), `execution/artifact-metadata.ts`, and `tasks/data-profile.ts`. One added line per site, no other edit. `tsc -p tsconfig.json` is the completeness check.
- [x] 1.4 In `src/loop/tool-detail.ts`, change `computeDetail`'s guard to test for a function rather than for presence, so a packaged tool that somehow carries a non-function is treated as undescribed instead of invoked.
- [x] 1.5 Extend `src/tools/define-tool.test.ts`: a `"none"` definition constructs and packages no `describeCall` property; a function definition still packages one; the sentinel appears nowhere in the serialized tool.

## 2. Add the seven roster hooks

Each hook is one line beside its `inputSchema`. Each rule is specified in `design.md` under "Hook rules are specified against `execute`" — follow the tool's own resolution order, not the schema's field order.

- [x] 2.1 `list_available_refs` (`tools/sandbox/list-available-refs.ts`) — `path ?? category ?? query`, falling back to a label for the bare full-store browse. Mirrors `execute`'s `path ?? category`; `query` ranks last because it is an additive filter, not an alternative.
- [x] 2.2 `list_available_packages` (`tools/sandbox/list-available-packages.ts`) — `names` first (it is what `queryPackages` returns on before reading anything else), then `query` and/or `language`, then a label for the bare listing.
- [x] 2.3 `inspect_data_profile` (`tools/research/inspect-data-profile.ts`) — `scope ?? "overview"`; when the scope is `files`, include `page ?? 1`. Both defaults must be in the hook, or the ordinary `{}` call produces nothing.
- [x] 2.4 `generate_plan` (`tools/research/generate-plan.ts`) — the `researchQuestion`. Leave the shortening to the cap from group 4; do not hand-cut it here.
- [x] 2.5 `show_plan` (`tools/workspace/show-plan.ts`) — the `planId`.
- [x] 2.6 `show_file` (`tools/workspace/show-file.ts`) — `files[0].path` when the call carries one file, a count when it carries several. `.min(1)` on the array is what makes index 0 total after parse.
- [x] 2.7 `show_user` (`tools/display/show-user.ts`) — the `kind`, plus the `title` when the call supplies one.
- [x] 2.8 Add one case per new hook to `src/tools/describe-call.test.ts`, asserting the exact string produced. Cover, for each tool that has them: the all-fields-omitted call, and a call setting two fields whose precedence the rule decides.

## 3. Mark a truncated detail

- [x] 3.1 In `src/loop/tool-detail.ts`, make `capCodePoints` cut to `max - 1` code points, `trimEnd()`, then append `…`. A string within the cap is returned untouched.
- [x] 3.2 Extend `src/loop/tool-detail.test.ts`: an over-long detail ends with the mark and is still at most 120 code points; a detail within the cap carries no mark; a cut landing on whitespace does not strand a space before the mark; the existing surrogate-pair case still holds.

## 4. Measure each call's own duration

- [x] 4.1 In `src/loop/run-agent.ts`, have `dispatchTools` return `{ results, durations }` with the arrays positionally aligned. Bracket each step-mode call around its `runStep(...)` call inside the `Promise.all` map, and each workflow- and inline-mode call around its `dispatchTool(...)` await.
- [x] 4.2 Thread `durations` into `settleRound` alongside `details`, and emit `durationMs` on `tool-finished`. Both dispatch paths — the truncated-round path and the normal path — go through the same call, as `details` already does.
- [x] 4.3 Add `durationMs?: number` to the `tool-finished` event in `src/contracts/chat-events.ts` and its Zod counterpart in `src/contracts/schemas/chat-events.ts`. Optional and absent-when-unmeasured, never zero.
- [x] 4.4 Extend `src/loop/run-agent.test.ts`: a round mixing a fast and a slow step-mode tool reports distinct durations rather than one shared figure; a round of sequential workflow-mode tools does not charge the later calls for the earlier ones; a call that errors still carries a duration.

## 5. Verify

- [x] 5.1 `tsc -p tsconfig.json` — this is what proves the group 1 sweep is complete.
- [x] 5.2 `bun test`.
- [x] 5.3 `bun run format:file` on every touched file under `src/`.
- [x] 5.4 Confirm the conversation roster in `src/agents/conversation-agent.ts` now carries 17 described tools of 35, and that no tool on it declares `"none"` by oversight rather than by decision.
