# Design — resolving the audited wiring gaps

Each decision is stated as **Context → Options → Recommendation → OPEN
(owner: Radu)**. Nothing here is implemented until the owner picks a direction;
the recommendation is the author's default, not a fait accompli. Evidence
`file:line` references were verified against `main` at audit time.

## Decision 1 — Regulatory grounding feature: finish or remove

### Context

Four target-assessment synthesis briefs instruct the model to call retrieval
tools that it cannot reach:

- `prompts/target-assessment/briefs/{target-organ-liabilities,liability-bullets,executive-recommendation,translational-commentary}.ts`
  tell the model to call `search_regulatory_guidance` and
  `find_approval_precedent`.
- `search_regulatory_guidance` is **defined nowhere** — no `defineTool({ id:
  "search_regulatory_guidance" })` exists in `src/`. `state/init.ts:177`
  nonetheless comments that it is "the search_regulatory_guidance tool wired
  into the synthesis agents" — a false claim in a shipped DB migration.
- `find_approval_precedent` **is** defined (`tools/bio/find-approval-precedent.ts:44`)
  and re-exported from the bio barrel, but is in no agent's roster, not in the
  `SandboxToolName` union, and not on the public surface — a fully orphaned tool.
- Even if both existed and were rostered, the synthesis path could not call
  them: `structured-llm.ts:102-108` wires exactly one tool, `submit`, with
  `toolChoice: { type: "tool", toolName: "submit" }`, forcing single-shot
  structured output. Its own header (`:9-13`) admits the port "drops those
  grounding tools." The prompts were never reconciled with that port.
- The remaining scaffolding is inert: the `cortex_regulatory_chunks` table
  exists, the 90-day boot refresh (`tasks/regulatory-corpus-boot-refresh.ts`,
  `maybeKickOffRegulatoryCorpusRefresh`) has no caller, and corpus filtering
  (`lib/regulatory-corpus.ts:155`) is "not yet applied."
- **No spec** references any of this. The feature was scaffolded and abandoned
  mid-integration.

### Options

- **A — Build it.** Author a `regulatory-grounding` spec; implement
  `search_regulatory_guidance` over `cortex_regulatory_chunks`; give the
  synthesis briefs a real tool-calling pass (either a pre-synthesis retrieval
  step whose results are injected as context, or a two-phase agent that can call
  tools then emit `submit`); wire `find_approval_precedent` into that roster;
  wire the corpus boot refresh; apply corpus filtering. Largest surface; delivers
  regulator-grounded synthesis.
- **B — Descope it (recommended).** Strip the `search_regulatory_guidance` /
  `find_approval_precedent` imperatives from the four briefs; delete the orphan
  tool, the boot-refresh task, and (if nothing else reads it) the corpus lib +
  table + the false `state/init.ts` comment. Leaves synthesis exactly as it runs
  today (single-shot `submit`, no regression) and stops instructing the model to
  call absent tools. Re-propose as a first-class speced feature when it is a
  committed capability.
- **C — Minimal honesty.** Keep the scaffolding but remove only the unsatisfiable
  tool-call instructions and correct the DB comment. Cheapest, but leaves dead
  corpus code as a maintenance trap.

### Recommendation

**B.** A half-wired, unspecified feature that tells the model to call
nonexistent tools is a net negative: it burns tokens on failed tool calls,
produces confusing runtime behaviour, and misleads maintainers via the false DB
comment. Regulatory grounding is worth doing — but as a designed, speced feature,
not as resurrected scaffolding. If product wants it now, choose A and this change
splits Decision 1 into its own spec-driven change.

### RESOLVED — remove references to what does not exist; wire what does (option A). The `search_regulatory_guidance` (no such tool) instructions were stripped from the four briefs and the false `state/init.ts` comment corrected. `find_approval_precedent` is now WIRED via option A — a deterministic pre-synthesis `ta-approval-precedents` step queries openFDA once for the dossier's indication and injects a `## FDA approval precedents` block into all four synthesis prompts, keeping synthesis single-shot; the orphan `defineTool` wrapper was removed (its fetch became a plain function). Delivered in the follow-up change `ground-synthesis-with-approval-precedents`.

## Decision 2 — Boot lifecycle & observability ownership

### Context

Components the specs treat as live are reachable only from tests:

- `validateAgentSkills` (`agents/sandbox/validate-skills.ts:22`) — the
  `agent-skill-assignment` spec's **"Boot-time skill validation"** requirement
  SHALLs that the harness verify at startup that every declared `meta.skills`
  pack resolves to a readable `SKILL.md`, failing fast otherwise. Zero callers,
  not on the barrel. A typo currently degrades to a runtime `skill_not_declared`
  instead of a boot failure — a live spec violation.
- The graceful-shutdown sequence (`runtime/shutdown.ts`) and the
  connection-budget guard (`runtime/connection-budget.ts`) are named in
  `structured-logging` and `harness-durable-runtime` as long-lived runtime
  components, but both are imported only by their own tests.
- `runtime/lifecycle.ts` (`isDraining`/`markDraining`) is inert — the flag is
  never set or read, so the drain gate does nothing.
- `initOtel` (`lib/otel.ts:39`) has no caller; its own doc (`:4`) claims it is
  "called explicitly from index.ts." OTel metrics are required elsewhere
  (`harness-thread-history` SHALLs a metric on every `loadRecent`), so those
  emit into an uninitialized SDK.

The root question is ownership. The harness is "a library, not a server," so it
is legitimate for process-lifecycle calls (`initOtel`, `markDraining`, running
the shutdown sequence) to be the **embedder's** job at its composition root. But
`validateAgentSkills` needs only `skillsDir` + the agent catalog — both available
at assembly — so it is naturally harness-owned.

### Options

- **A — assembleCoreRuntime owns boot validation; embedder owns process
  lifecycle (recommended).** Thread `skillsDir` into `assembleCoreRuntime` and
  call `validateAgentSkills(skillsDir, catalog)` there (fail-fast, satisfies the
  spec). Export the shutdown/lifecycle/otel handles from the barrel and document
  that the embedder wires them into its process signals. Fix the `otel.ts`
  comment to say the embedder calls it (or delete the claim).
- **B — assembleCoreRuntime owns the whole lifecycle.** `assembleCoreRuntime`
  additionally calls `initOtel`, installs signal handlers, and drives shutdown.
  Simplest for the embedder, but bakes a process-level policy into a library and
  conflicts with the "library, not a server" stance and DI discipline.
- **C — Relax the specs to embedder-owned.** Move the boot-validation and
  shutdown obligations out of the harness specs and into the embedder's spec
  tree; harness only exports the pieces. Least code change; weakest guarantee
  (nothing forces an embedder to validate skills).

### Recommendation

**A.** It satisfies the spec-mandated `validateAgentSkills` boot check at the one
seam that has the inputs, keeps process/signal policy with the embedder (correct
for a library), and makes the OTel/shutdown wiring an explicit, exported,
documented embedder step. `validateAgentSkills` wiring is the highest-value,
lowest-risk item in this whole change and should land regardless of the rest.

### RESOLVED — the harness owns an ordered boot sequence. Implemented as `bootHarness` (`runtime/boot.ts`) wrapping a still-pure `assembleCoreRuntime`; it runs `validateAgentSkills` before launch and returns a `shutdown` handle. Telemetry stays injectable (default no-op) so the CLI's own OTel is not double-initialized. CLI adoption of `bootHarness` is the remaining step (tasks.md §2).

## Decision 3 — Report-builder skill reachability

### Context

`prompts/report-builder.ts:48,57` instructs the model to `skill_search` /
`skill_read` on the `report-html` pack, including a concrete
`skill_read("report-html", "references/design-system.md")`. But `createSkillTools`
is invoked in exactly one place — `agents/sandbox/shared.ts:301`, for sandbox
agents — and report-builder is explicitly not a sandbox agent
(`agents/report-builder.ts:13`). Its assembled roster
(`execution/report-runner.ts:178-197`) is `build_report`, `submit_report`,
`mint_preview_url`, `preview_snapshot`, and the four `createVersionFsTools`
tools — **no `skill_*`**. Every skill call the prompt dictates fails.
Separately, `skills/report-pdf/` and `skills/report-pptx/` are referenced by
nothing in `harness/src` (only `skills/README.md`).

### Options

- **A — Give report-builder the skill tools (recommended).** Wire
  `createSkillTools({ skillsDir, skills: ["report-html"] })` into the
  report-runner roster so the prompt's `skill_*` calls resolve. Makes the
  richest design-system reference (`report-html/references/design-system.md`)
  actually reachable, which is clearly the prompt author's intent.
- **B — Strip the skill instructions.** Remove the `skill_search`/`skill_read`
  guidance from the prompt and rely solely on the read-only `templatesDir` mount.
  Simpler, but discards the design-system reference material the pack exists to
  provide.

For the orphan packs: **keep** `report-pdf`/`report-pptx` only if a PDF/PPTX
report path is on the roadmap; otherwise **remove** them (and their `README.md`
lines) as unlinked content.

### Recommendation

**A** for report-html (the pack is real and useful and the prompt already
depends on it). **Remove** `report-pdf`/`report-pptx` unless a report-format
roadmap claims them — right now they are pure orphan content.

### RESOLVED — option A, done, plus the orphan packs removed. `report-html` skill tools (`skill_search`/`skill_read`) are wired into the report-builder roster; `skillsDir` threads from the embedder through the conversation deps. Verified end-to-end (CLI tsc clean after `dist` rebuild). The orphan `report-pdf` / `report-pptx` packs were REMOVED (no agent, no roster, no PDF/PPTX render path referenced them); the `skills/` README and the `agent-skill-assignment` pack-inventory requirement (23 → 21 packs) were updated to match.

## Decision 4 — 402-resume path: confirm or retire

### Context

`workflows/resume-execute-analysis.ts` (`prepareExecuteAnalysisResume`,
`MissingRunError`, `PrepareResumeResult`) implements resuming a parent
`executeAnalysis` after a 402 `budget_exceeded` pause. It is tested but has no
in-tree caller and is not exported from the barrel; its doc says the entry point
"is owned by change 9." The 402-pause machinery it feeds
(`attempt_count` bump → `open/close-running-charge:${attempt}`) exists in
`execute-analysis.ts`, but nothing resumes.

### Options

- **A — Leave as tracked scaffolding (recommended if change 9 is live).** Keep
  the code; add a `tasks.md`/tracking note pointing at change 9 so it is not
  mistaken for dead code by the next audit.
- **B — Retire it.** If change 9 is abandoned, delete the resume module and its
  test and remove the 402-pause `attempt_count` bump it exists to serve.

### Recommendation

Confirm change 9's status first. If it is still planned, **A** (and annotate it
so it stops reading as orphaned). If not, **B**.

### RESOLVED — retired (option B). "Change 9" does not exist (this repo names changes by kebab slug, never numerically; no change owns the resume entry point), so the `prepareExecuteAnalysisResume` module was unreachable scaffolding. Retired: deleted `resume-execute-analysis.ts` + its test, removed the `bumpRunAttemptCount` helper, the `cortex_runs.attempt_count` column, the `CortexRunRow.attemptCount` field, and the whole `attempt` cache-busting thread through `execute-analysis.ts` / `sandbox-step.ts` (step names lose their now-always-`0` suffix). The 402-PAUSE itself is KEPT (a budget-exceeded run still suspends to `suspended_insufficient_funds` with a DBOS-resumable `CANCELLED` parent) — only the never-built resume half went. Specs updated: `run-state-persistence` and `workflow-failure-lifecycle` deltas drop the removed pieces. The deferred resume capability is captured as a new placeholder change `resume-analysis-after-budget-pause`.

## Non-goals

- The trivial doc corrections (README `ANTHROPIC_*`, CLAUDE.md `~230 LOC` and
  dead `docs/` links, CONTEXT.md `run-resume.ts` and "four seams", the
  `ToolContext` "three"→"four" JSDoc, the conversation-agent report-tool count)
  and the deletion of clearly-superseded dead modules (`register-workflows.ts`,
  the two orphan target-assessment `steps/*`, `correction-loop.ts`, and the
  unused `lib/*` helpers) are handled directly on the `fix/harness-wiring-gaps`
  branch and are **out of scope** for this decision gate.
