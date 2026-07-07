# 12 — Planner Flow, the Approval Gate, and Resolving #32 (RQ4 / RQ5)

Written 2026-07-07, researched against HEAD `825d7825643caff9c75e6a1cc4207aac5de1416f`.
Traces `generatePlan` → plan review → `executePlan` in the harness source, names where
the human approval gate actually lives and what the no-litter boundary is, then prices
the #32 (plan-intake author/replay inversion) resolution options and recommends one.

---

## 1. `generatePlan` traced (`harness/src/tools/research/generate-plan.ts`)

An outer conversation-agent tool driving an inner "planner" agent to a terminal tool.

- **Input** (`:412-430`): `{dataContext, researchQuestion, priorRuns?, userConstraints?,
  parentPlanId?}` — all prose; the conversation prompt instructs the agent to pass
  rich structured context (data profile, prior runs, constraints). `parentPlanId`
  (`/^pln-[a-f0-9]{8}$/`) marks plan *iteration*: the parent plan is loaded, formatted
  as a markdown block ("Prior Plan (… — being iterated) … Reuse step IDs when a step's
  purpose is unchanged", `:100-123`), and prefixed to the planner prompt; an invalid
  parent fails fast before the planner runs (`:437-458`).
- **Inner agent** (`:477-483`): id `"planner"`, `maxIterations = 13` ("1 draft + ~3
  validate/fix cycles + 1 submit + headroom", `:47-50`), wall clock 600 s
  (`PLAN_TIMEOUT_MS`, `:53`; merged with the outer abort via `AbortSignal.any`,
  `:487`), prompt = `plannerPrompt(formatAgentCatalog(), resourcePolicy)` — the agent
  catalog placeholder plus the host's per-step ceilings (resource-budgeted scheduling
  change; settled, not re-researched).
- **Inner tools** (`buildInnerTools`, `:221-329`) — the outcome channel is a
  closure-captured `OutcomeHolder` (`PlannerOutcome`, `:70-78`), and the driver is
  `runToTerminal` (`loop/run-to-terminal.ts:57-77`) which grants ONE salvage
  continuation (terminal tools only, `salvage:`-namespaced step names, default 3
  iterations) if the loop ends without an outcome:
  - `validate_plan` — non-terminal dry-run: `PlannerPlanSchema` + `validatePlan` with
    `perStepCeiling: resourcePolicy?.perStep` (`:224-236`, `fullyValidate` `:165-200`).
  - `submit_plan` — terminal success: re-validates, then **persists**
    (`insertPlan(pool, {analysisId, plan: hydratePlanSteps(plan), parentPlanId})`,
    `:265`), records `{kind: "plan_submitted", planId, plan}`; a second terminal call
    is rejected (`:247-257`).
  - `request_clarification`, `report_blocker` — terminal, recorded verbatim.
- **Output** (`shapeOutcome`, `:344-383`): `PlanningAgentOutput` =
  `plan_complete {planId, plan}` | `clarification_needed {question, questionContext?}`
  | `error {error}` (blocker, persist failure, timeout, cancel, or
  no-terminal-outcome all map to `error` with distinct messages).

**Load-bearing fact for #32**: `insertPlan` mints a **random** id —
`` const planId = `pln-${randomUUID().slice(0, 8)}` `` (`state/plans.ts:66`). Planner
ids are random; file-intake ids are content-derived
(`sha256(analysisId + "\n" + bytes)`, `cli/src/modules/harness/plan_intake.ts:117-123`).
Both satisfy the same `/^pln-[a-f0-9]{8}$/` contract (`state/plans.ts:19`), and
`upsertPlan` (the intake's write) is insert-if-absent on any conforming id
(`state/plans.ts:108-127`). The two id disciplines coexist in one table by
construction — but they are **not interchangeable**: see §4b.

## 2. RQ4 — where the approval gate lives

**The gate is conversational and prompt-enforced. There is no structural gate anywhere
in the harness.** The plan is already persisted (by `submit_plan`) before any human
sees it; "approval" changes nothing in the database — it is the user's message that
licenses the model to call `execute_plan`.

The prompt is the mechanism (`harness/src/prompts/conversation.ts:57-73`):

> "3. **Handle the response**: **plan_complete** → present the plan via
> `show_plan({ planId })` … and explain the analytical narrative in text. **Ask for
> approval.** … 5. **Execute** — on approval, call `execute_plan({ planId })` with the
> approved `planId`."

reinforced by the anti-pattern list (`conversation.ts:635-636`):

> "- **Trigger workflows without user approval.** Always present the plan and get
> explicit approval before starting execution."

`show_plan` (`tools/workspace/show-plan.ts:37-51`) emits a `data-plan` part with the
full plan content embedded "so the UI can render it without a follow-up fetch"; plan
iteration re-enters `generate_plan` with `parentPlanId` + the user's feedback as
`userConstraints` (prompt step 4).

The managed host confirms this is the whole product mechanism: "There is no UI approval
endpoint and no auto-execute … the 'Execute' action a user takes in the UI is surfaced
back to the model, which calls `execute_plan` — there is no separate approval REST
route" (verified against `cortex/harness/routes/` inventory and the identical prompt
text at `cortex/harness/prompts/conversation.ts:57-73,635-636`). A TUI "Approve /
Request changes" affordance on the `data-plan` card is therefore **UX sugar that sends
a user message**, not a new control channel — and `execute_plan`'s description hardens
the loop against the inverse ("Do not instruct the user to invoke any tool",
`tools/execute-plan.ts:109`).

**Trust framing for the adoption design**: the model is trusted to wait for approval;
the failure mode (model calls `execute_plan` unprompted) costs real sandbox compute.
If the cli wants a *hard* gate later, the seam exists — `execute_plan` already owns a
dedup→reserve→authorize→launch pipeline (§3) and the embedder controls the
`RunAuthorizer`; a "pending-approval" authorizer realization could refuse un-flagged
launches without any harness change. Not required for the skeleton; worth naming in
the OpenSpec proposal as the structural option. **#32's story 3 (file round-trip as the
review gate) is NOT the product approval path** — it is an optional inspect/edit/replay
detour (§4).

### The no-litter boundary, named

Nothing in the planner flow touches the user's filesystem. `generate_plan` persists to
`cortex_plans` (Postgres); `show_plan` emits a chat part; `execute_plan` writes ledger
rows and launches a workflow whose artifacts land in the hidden session tree
(`sessions/{analysisId}/runs/…`). Under the no-litter policy (passive flows never
write user-visible files; only deliberate actions do), the boundary for adoption is:

- **Never**: a plan file written as a side effect of planning, approving, or executing
  — the plan's home is the plan store + the chat card.
- **Only on explicit deliberate action**: a future `inflexa plan export <runId|planId>`
  (writes a protocol file where the user asks, the #32 story-2 surface), and the
  existing hand-authored `--plan` file the *user* creates. These are the only two
  plan-file touchpoints; both are user-initiated commands.

## 3. `executePlan` traced (`harness/src/tools/execute-plan.ts`)

Input `{planId}` only (`:46-50`); the session carries scope. Flow (header `:9-27`, body
`:111-255`):

1. Guards: analysis-scoped session + auth capability present (`:131-136`).
2. `loadPlan(pool, planId, {analysisId})` → `AnalysisPlanSchema.safeParse` →
   `validatePlan` — server-side re-validation of the stored plan (`:140-150`).
3. **Dedup pre-check** `queryActiveRun(pool, analysisId, planId)` — a hit returns the
   existing runId, emits the run card, no authorize/launch (`:155-159`).
4. **Reserve**: `runId = randomUUID()`; `insertRun({runId, analysisId, threadId,
   workflowName: "executeAnalysis", planId})` BEFORE authorizing; the partial-unique
   index is the race backstop, the loser resolves the winner (`:167-190`).
   `threadId = session.scope.threadId ?? null` (`:138`) — **this is where conversation
   → run lineage is stamped** (`cortex_runs.thread_id`, `state/init.ts:56,69-70`; the
   managed chat route rebuilds the session with `threadId` in scope precisely so this
   lands, `cortex/harness/routes/chat.ts:160-170`). The cli's replicated trigger passes
   `threadId: null` (`run.ts:166,226`) — correct for a command-launched run.
5. **Authorize**: `runAuthorizer.authorize({auth, scope, provenance, frame: {runId}})`;
   failure marks the row `failed` and rethrows (`:195-209`).
6. **Build input**: per-step prompt/agent/resources/timeout maps via
   `renderStepPrompt`, `planSummary` = title or narrative slice,
   `budget: resourcePolicy?.budget` snapshotted at the async edge, `runSession` +
   `ownsMandate` from the authorization (`:212-237`).
7. **Launch**: `runLauncher.launch(executeAnalysisWorkflow, {workflowId: runId},
   input)`; failure revokes + marks failed (`:242-251`). Results are pull-only
   (`inspectRun` on a later turn); the user sees a `data-run-card` (`:116-129,253`).

The cli's `triggerAnalysisRun` (`run.ts:197-277`) replicates 3–7 call-for-call (change
F D2); the delta is `threadId: null`, a synthetic `Provenance` literal
(`cli-run-launch`, `run.ts:146`), and clack-side error shaping.

## 4. RQ5 — resolving #32 (author/replay split)

### 4a. What exists and what the clearing contracts say

- `plan_intake.ts` header (`:1-9`): "deliberately temporary dev surface … when the
  planner arrives, **retire file intake or demote it to an explicit debug tool**."
- `run.ts` header (`:1-15`): the replicated trigger "exists ONLY to drive the run
  engine from the cli before the conversation-agent/planner adoption lands a shared,
  callable trigger … retire this replica together with file intake."
- `cli/openspec/specs/plan-intake/spec.md:4`: "This capability is expected to be
  REMOVED when the planner is adopted", with the requirement block (`:8-24`) recording
  the same contract at spec level. `analysis-run-launch/spec.md:4` frames the launch
  capability as "Replicates the harness's own `executePlan` trigger flow (the cli runs
  no conversation agent)" and depends on the plan-intake gates (`:18-20`).
- Issue #32 proposes inverting: file intake = the **replay** surface, planner = the
  **author**; add `inflexa plan export`; hand-authoring demotes to a dev workflow.

### 4b. The id-scheme fact both options must price

An exported planner plan does **not** round-trip to its own id. Planner ids are random
(`state/plans.ts:66`); intake ids hash `(analysisId, exact file bytes)`
(`plan_intake.ts:117-123`). So `plan export pln-aaaa1111` → file → `run --plan file`
derives a **new** id `pln-<hash8>` and a new `cortex_plans` row (upsert-if-absent), and
the replay run dedups against the *new* id. Consequences:

- Re-running an unchanged exported file is idempotent against itself (same bytes →
  same id → dedup attach) — the property replay wants. ✓
- The replayed run is **not** linked to the originating plan row: `parent_plan_id` is
  intake-settable (`upsertPlan` takes `parentPlanId`, `plan_intake.ts` passes none) but
  nothing carries "exported-from pln-aaaa1111" today. If provenance-grade replay
  lineage matters, `plan export` should embed the source planId in the exported file
  (making it part of the hashed bytes — deterministic) and/or intake should set
  `parentPlanId` from it. Cheap either way; must be a deliberate line in the export
  change.
- Export must pick a canonical serialization (key order/whitespace) since the id
  hashes exact bytes — #32 already flags this.
- Cross-analysis replay (`run <other-analysis> --plan protocol.json`) re-keys by
  analysisId — two analyses running one protocol get distinct plan ids, which is
  correct (plan ids are the run-dedup key per analysis).

### 4c. Options priced

**Option A — execute the contract as written (delete at adoption).**
Work: remove `plan_intake.ts` (+test), the `--plan` arm of `run.ts`, archive the
`plan-intake` spec; `analysis-run-launch` loses its validation-precedes-boot clause.
Price: destroys the only file-based execution surface — protocol replay (bioinformatics
labs' daily loop, #32 story 1), the human-inspectable interchange format, and the dev
tool that made the run engine testable without a model. Nothing structural forces the
deletion: intake writes through the same `upsertPlan`/`validatePlan` gates as the
planner, so coexistence costs no invariants. **Rejected** — the contract's premise
("file intake exists only because the planner didn't") turned out wrong; the file is a
first-class artifact in this domain.

**Option B — invert per #32 (author/replay split). RECOMMENDED, staged:**

1. *At adoption (docs-only, in the adoption change):* rewrite the three clearing
   contracts — `plan-intake` spec purpose becomes "protocol replay surface; the planner
   is the primary author; hand-authoring is a dev workflow"; the `TODO(extend)` headers
   in `plan_intake.ts` and `run.ts` update to match (they currently instruct future
   readers to delete the surface). Price: ~an hour; zero code.
2. *`run.ts`'s replicated trigger is resolved by #33 M2, not by inversion:* when the
   run engine moves behind the daemon, the daemon's trigger endpoint becomes the one
   flow both `execute_plan`-in-chat and `inflexa run --plan` exercise (the cli replica
   is absorbed into daemon code the same way `waitForTerminalStatus` becomes an SSE
   consumer, #33 note 4). #32's item 4 ("bless the replica or extract a shared harness
   trigger") therefore needs no harness extraction — record that in the rewritten spec.
3. *Post-M3 follow-up change:* `inflexa plan export` — dump `cortex_plans.plan` to a
   canonically-serialized file (+ embedded source planId per §4b), the inverse of
   intake; protocol templates in `skills/` stay optional later work.
   Price: small change, one canonical-serialization decision, one lineage decision.

**Option C — demote to hidden debug tool.** Keep the code behind a dev flag, keep the
"REMOVED" spec language. Price now ~zero, but it forfeits #32's product stories and
leaves a spec that misdescribes intent — the same drift this research kept finding in
stale docs. **Rejected** as the steady state; acceptable only as "do nothing until
adoption lands" (which stage B.1 makes unnecessary — the rewrite is nearly free).

### 4d. What stays / what retires (Option B end-state)

| Piece | Fate |
|---|---|
| `validatePlanFile` / `persistPlan` / deterministic `pln-` derivation (`plan_intake.ts`) | **Stays** — the replay gate; unchanged code, rewritten header |
| `inflexa run <analysis> --plan <file>` | **Stays** as the replay command; its trigger internals migrate into the daemon at M2 |
| Hand-authoring plans | **Demoted** to a documented dev workflow (it is just "author the file yourself") |
| `triggerAnalysisRun` replica (`run.ts:197-277`) | **Absorbed** by the daemon trigger endpoint at M2; until then stands under the rewritten header |
| `plan-intake` spec "expected REMOVED" purpose + requirement | **Rewritten** at adoption (stage B.1) |
| `inflexa plan export` | **New** post-M3 change (canonical bytes + source-plan lineage) |

## 5. Open user decisions (RQ4/RQ5 slice)

- [ ] **Accept the prompt-enforced approval gate for the walking skeleton** (with the
      `RunAuthorizer`-based hard gate named as the structural option if unprompted
      launches are ever observed), or require a TUI-side hard gate from day one?
- [ ] **#32 resolution** — Option B (invert, staged) is recommended; confirm, since it
      formally reverses a spec-level clearing contract two archived changes carry.
- [ ] **Export lineage** — embed source planId in exported files and/or set
      `parentPlanId` on replay intake (§4b)? Recommend: embed in file (survives
      transport, deterministic); decide at the `plan export` change.
