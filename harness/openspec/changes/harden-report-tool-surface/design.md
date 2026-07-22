## Context

The report path accumulated a set of claims that the implementation never honoured: a `format` value with no code behind it, an iteration precondition nobody checks, a path contract stated in two places and implemented as its opposite, and four descriptions naming things that do not exist. Individually each is small. Together they form the subsystem's dominant defect class, because prompts and tool descriptions are the one layer no typechecker validates — a stale claim stays green until an agent acts on it.

The failure shape is consistent and expensive: the agent does the right thing according to what it was told, gets a result that contradicts it, and has no way to diagnose the gap. The user-reported double-encoding incident is the extreme case — four identical retries and an escalation to the wrong bug tracker — but the same shape recurs at lower cost throughout.

The constraint on this change is that the subsystem is about to ship and is scheduled for a rebuild afterward. So the bar is: remove the traps a shipping user can hit, change nothing structural, and leave the larger rework to issue #197.

## Goals / Non-Goals

**Goals:**

- No agent-facing copy on the report path names a capability the implementation does not provide.
- Every failure a user can trigger is immediate, actionable, and attributable — never a silently wrong artifact or a silently relocated file.
- Total change stays contained: no new modules, no new dependencies, no seam or interface reshaping.
- Consumers of persisted previews and the chat-part contract are unaffected.

**Non-Goals:**

- The brief-aware postcondition, design-system conformance checks, a local `PreviewPublisher`, a Chrome sidecar, and the preview audit tool. All tracked in issue #197 and deliberately deferred to the rebuild.
- Making PDF actually work. This change removes the false promise; it does not add the capability.
- Reconciling the `iterative-report` spec's stale `iterate_report` naming beyond the requirements this change already touches.
- Vendoring the CDN dependencies, emitting `data-value` for numeric table sorting, the dead `errorKind: "render"` variant, and the unenforced three-build-attempt cap.
- Two managed-only preview defects: `preview_snapshot` reusing a version-pinned URL cell after `mint_preview_url` pins an older version, and `waitForSelector`'s swallowed 5s timeout. Both are unreachable while the OSS seam returns unavailable.

## Decisions

**Narrow the input enum rather than implement or reroute PDF.** The alternative — accept `"pdf"` and return a clear "not supported" error from `execute` — keeps the value visible in the schema and so keeps inviting the model to try. Removing it from the enum makes the tool surface itself honest, and the model never composes the call. Rejected: silently coercing `"pdf"` to `"html"`, which reproduces the current defect with extra steps.

**Keep the persisted `"html" | "pdf"` unions.** Only the *input* enum narrows. `preview-meta.json` and `PreviewPart.format` keep their wider type so previews written before this change still parse, and no consumer contract moves. The cost is a union with a now-unreachable arm, which is the correct shape for a field that records history rather than intent.

**Refuse an unknown `previewId` rather than fall back to creation.** Falling back — treating an unknown id as a fresh v1 — is what happens today, and it is precisely the failure: the builder receives modification instructions, no template, and no brief. Silently converting an iteration into a creation would also discard the user's intent without telling them. A refusal is the only outcome that keeps the agent's next move obvious.

**Place the check before access minting and asset staging.** The check is cheap (a directory read) and everything after it is not: minting an access grant, copying and parsing sources, and starting a 75-iteration agent. Ordering it first means an unknown id costs no model turns and leaves no partial state.

**Make the code match the documented path contract, not the reverse.** Two other options existed: keep the leading-slash strip and rewrite the prompt and description to describe it, or keep stripping but warn. Rewriting the copy would preserve a real trap — a deep absolute path still lands a file at an unintended nested location and reports success, and the builder has no directory-listing tool to find it. Rejecting is the only option where the failure is discoverable by the agent that caused it.

**Accept that a benign absolute path now errors.** `"/index.html"` currently resolves and works. After this change it returns `out_of_scope`. This is a deliberate trade: the prompt already mandates relative paths, the rejection names the offending path, and the correction is a single character. Tolerating the benign case is what makes the harmful case undetectable, since both arrive through the same normalization.

**Log the unavailable preview seam at the tool, not at the composition root.** The composition root knows it wired an unavailable publisher, but only the tool knows a build actually reached the point of needing it. Logging at the seam's point of use is what distinguishes "this deployment has no preview surface" from "this report skipped its verification step". `preview-snapshot.ts` takes no logger today, so this adds the dep in the established `logger?` optional form resolved once against `createNoopLogger()`.

**Treat the description corrections as a single unit of work.** The four stale claims share one root cause and one review question — does this sentence describe something the code does? Splitting them across tasks would obscure that they are instances of a pattern, which is the thing worth noticing at review time.

## Risks / Trade-offs

**An agent mid-conversation retries `format: "pdf"` against the narrowed enum** → The rejection arrives at the tool boundary with the standard input-validation error naming the offending field, which is the same path any schema violation already takes. The conversation prompt's PDF claim is removed in the same change, so the model has no remaining reason to compose the call.

**An absolute path that previously worked now fails** → Scoped to the report-builder's own roster, which no embedder or user code calls. The prompt already mandates relative paths, and the error names the path so the fix is mechanical. Worth flagging in review as the one behavioural change an existing agent could notice.

**The `previewId` existence check rejects a legitimate iteration** → The check is a directory read for any `v{N}` under the preview root, which is exactly the condition the runner already uses to resolve the base version. A preview that would have iterated successfully has at least one such directory by construction, so the check cannot refuse a case the current code would have handled correctly.

**Removing the `theme.css` reference loses design guidance** → It does not. The tokens it names are redefined inline in `base.html.j2`, and the reachable material is the `report-html` skill pack the builder already reads through `skill_read`. The removed reference pointed at a file the builder has no tool capable of opening.

**A future reader assumes PDF was dropped rather than never built** → The spec states that the rendered artifact is always `v{N}/index.html` and that no other format is produced, so the record reflects the actual history rather than implying a removed capability.

## Migration Plan

No data migration and no consumer coordination. The persisted `format` field keeps its type, so previews written before this change load unchanged.

Rollback is a straight revert: every change is additive validation or copy correction, and none alters stored state, on-disk layout, or an emitted part's shape.

## Open Questions

None blocking. One deferred: whether `format` should eventually leave the input surface entirely rather than remain a single-valued enum. That decision belongs with the rebuild, when it is known whether PDF is being implemented or dropped for good.
