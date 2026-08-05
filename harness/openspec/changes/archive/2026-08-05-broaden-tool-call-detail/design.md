## Context

#287 built the call-detail mechanism: a `describeCall` hook colocated with a tool's Zod `inputSchema`, one normalization path at the emit site, and a resolver that derives a detail from a tool name and an input. All of it is in `src/` and works. What it does not do is cover the roster — ten of the conversation agent's 35 tools declare a hook — and the hook being optional means the gap reopens with every tool added.

Two constraints shape everything below.

The hook is **synchronous and pure**, typed `(input: z.infer<Schema>) => string`, and `computeDetail` calls it only after a successful `safeParse` of the raw model output. It therefore sees exactly one thing: the parsed input. It cannot await, cannot read the database, and cannot see anything `execute` computes. Several of the hook rules sketched in issue #289 assume otherwise, and this change specifies against the schemas instead.

The loop's dispatch round is **all-starts, then all-work, then all-finishes** (`run-agent.ts:390-395`). That ordering is deliberate — a host sees the whole round's chips appear at once, which is an honest preview of what the model asked for — and this change keeps it. It is also the direct cause of the duration defect, since a host bracketing the two events measures the round.

## Goals / Non-Goals

**Goals:**

- Seven more conversation-roster tools describe their calls, with each rule specified against what the tool's `execute` actually does.
- A tool author cannot silently omit the decision; declining stays available and becomes visible.
- A truncated detail is distinguishable from a complete one.
- A host can report what a call took, not what its round took.

**Non-Goals:**

- The bio-tool pass (`lookup_annotation`, `chembl`, `pubchem`, `open_targets`, …). Deferred, and now visibly deferred — each declares the opt-out until it gets a real hook.
- The result side (`✓ ok` for a call that did nothing) — issue #281.
- Any change to the round's emit ordering, the resolver, the wire `detail` field, or host rendering.
- Any duration on the reload path. `recordToolCall` stores the outcome and the detail, and `ToolCallPart` declares no duration field. Thus a recorded call replays without one, and this change does not add it. The duration is a live-surface diagnostic here.

## Decisions

### The `"none"` sentinel is an authoring-time type, never a runtime value

`ToolDefinition.describeCall` becomes `((input: z.infer<Schema>) => string) | "none"` and is required. `Tool.describeCall` — the packaged shape every consumer reads — is left exactly as it is: `describeCall?(input: Input): string`. `defineTool` packages the key only when the definition supplied a function, so `"none"` is consumed at construction and never reaches a reader.

This is the whole reason the enforcement is cheap. `createDetailResolver`, `activityForTool`, and the loop all keep reading "a function, or absent" and need no edit for the enforcement half of this change. `computeDetail` takes a one-line edit, but not to cope with the sentinel: its guard tests for a function so that a non-callable hook on an embedder-contributed tool counts as undescribed. The alternative — carrying the union onto `Tool` — would push a sentinel check into every one of those readers to buy nothing, since they all treat "declined" and "absent" identically anyway.

A string literal rather than `false` or `null` because it is greppable: `describeCall: "none"` across the tree is the roster of tools that have consciously declined, which is exactly the list a future coverage pass wants.

Structural ambiguity is not reachable: a hook that happens to return the string `"none"` is a function, and the discriminator is `typeof`, not equality.

### Timing is measured per call, inside `dispatchTools`, around the same unit the loop awaits

`dispatchTools` already partitions calls into `step`, `workflow`, and `inline` groups and awaits each differently — `Promise.all` for step tools, then two sequential passes. It is the only place that knows when an individual call started and stopped, so the measurement goes there, bracketing the same unit the loop awaits for that call (`runStep(...)` for a step tool, `dispatchTool(...)` for the other two).

Bracketing `runStep` rather than reaching inside it is deliberate: the durable-step wrapper is part of what the call cost, and on a cached replay the call genuinely was fast. Measuring inside would report a body that did not run.

`dispatchTools` returns `{ results, durations }` with the two arrays positionally aligned, matching how `details` is already threaded through `settleRound`. Both dispatch paths in the loop use it, so a truncated round and a normal one cannot report timing differently — the same reason `settleRound` is shared today.

Rejected: emitting `tool-started` immediately before each call's own dispatch, which would make a host's existing bracket accurate with no contract change. It breaks the round preview — the `workflow` and `inline` passes are strictly sequential, so a host would reveal those chips one at a time instead of showing what the model asked for. Correct timing is not worth making the round illegible.

### `durationMs` is optional on the wire and the host keeps a fallback

The field is `durationMs?: number`, absent rather than zero when unavailable. A host reads `event.durationMs ?? (its own bracket)`, so a consumer built against an older harness keeps working and one built against this harness gets the accurate number. This mirrors how `detail` was introduced in #287 and keeps the event additive rather than breaking.

### The cap reserves a code point for the truncation mark

`capCodePoints` cuts to `max - 1` code points, trims trailing whitespace, then appends `…` (U+2026, one code point). The total stays within the 120-code-point bound, so the cap remains a hard bound rather than a soft one that overshoots by a character.

`trimEnd()` runs before the append, not after, so a cut landing on a space yields `word…` rather than `word …`.

This stays in `normalizeDetail` rather than moving to the hooks, per the rule the module already states: normalization is not delegated to tool authors, because thirty authors would each get it slightly wrong. A hook that wants a shorter, hand-cut line is still free to return one — the cap only acts when the author did not.

### Hook rules are specified against `execute`, not against the field list

For four of the seven tools the obvious reading of the schema disagrees with what the tool does, and the tool wins:

| tool | rule | why |
|-|-|-|
| `list_available_refs` | `path ?? category ?? query`, else the store root | `execute` computes `path ?? category` and documents `category` as ignored when `path` is given. `query` is an additive filter that can accompany either, so it ranks last rather than first. `{}` is a legal full-store browse and needs a line of its own. |
| `list_available_packages` | `names` first, then `query`/`language`, else a listing label | `queryPackages` returns on `names` before reading anything else, and the tool's own description calls it the right call for "is X available?". A rule without it renders nothing for the dominant shape. |
| `inspect_data_profile` | `scope ?? "overview"`; when `files`, `page ?? 1` | Both fields are optional and defaulted inside `execute`. Without the defaults in the hook, the most common call — `{}` — produces no detail at all. |
| `show_file` | `files[0].path`, or a count when several | The path is one level below the top of the input. `.min(1)` on the array is what makes index 0 total after parse. |

`generate_plan`, `show_plan`, and `show_user` take their rules as the issue stated them; their fields are required and unambiguous.

## Risks / Trade-offs

**A ~59-site mechanical sweep lands in the same diff as real logic.** → Every declining site takes exactly one added line, `describeCall: "none"`, and no other edit. A reviewer can verify the sweep by its uniformity and read the seven real hooks separately. The compiler proves the sweep is complete, so nothing is missed silently.

**`defineTool` is exported from `index.ts`, so this breaks every embedder-contributed tool.** → That is the intent, and the break is loud: it is a type error at the definition site with a one-line fix, not a runtime surprise. Called out in the proposal's Impact so the release notes carry it.

**A replayed DBOS workflow re-emits its events, and a cached step replays fast.** → A tool call inside a replayed workflow will report the replay's duration, and the run-event stream folds latest-wins by id, so the original figure is overwritten. Bounded and accepted: the duration is a diagnostic, the conversation chips this change targets run on the chat route's passthrough step and never replay, and the alternative — persisting the first measurement — would put timing into durable state to fix a cosmetic line.

**A truncation mark changes strings that consumers may have asserted on.** → Only the harness's own tests assert exact detail strings, and the contract has always been that the detail is opaque display text a host renders and never parses. `describe-call.test.ts` is updated with the hooks it covers.

**Specifying hook rules against `execute` couples them to behavior a refactor could move.** → The coupling already exists and is the point: a detail that disagrees with what the tool did is worse than no detail. `describe-call.test.ts` pins one assertion per hook on the exact string it produces, so a rule that drifts from its tool fails there.

## Migration Plan

The type change and the sweep are one atomic step — the package does not compile between them, so they cannot be separate commits that both build.

1. Widen `ToolDefinition.describeCall` to the required union; keep `Tool` unchanged; update the packaging branch to key off `typeof def.describeCall === "function"`.
2. Sweep every `defineTool` site: the seven gaining hooks get real ones, the rest get `"none"`. `tsc -p tsconfig.json` is the completeness check.
3. Timing and the truncation mark, each independently revertable.

Rollback is per-item: the seven hooks, the truncation mark, and the timing change are independent. Only the required-decision change is all-or-nothing, and reverting it is the inverse sweep.

One coupling qualifies that. The `computeDetail` guard ships beside the truncation mark, because both edit `tool-detail.ts`. Thus a revert of the mark takes the guard with it. The guard is defensive and nothing depends on it, so the revert stays safe.

## Open Questions

None blocking. One deliberately deferred: whether the bio tools' shared `action`-keyed shape justifies a small helper rather than fourteen hand-written hooks. That is a question for the pass that writes them, not for this change, which leaves them declaring the opt-out.
