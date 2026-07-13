# Tasks — resolve audited harness wiring gaps

This change is a **decision gate**. Implementation tasks are grouped per
decision and stay unchecked until the owner picks a direction in
[`design.md`](./design.md). Spec deltas under `specs/` are authored **after** the
directions are chosen (they encode the chosen option), so `openspec validate
--strict` will report missing deltas until then — expected for a pre-decision
proposal.

## 0. Decisions (blocking)

- [ ] **Decision 1** — Regulatory grounding: build (A) or descope (B)? — owner: Radu
- [ ] **Decision 2** — Boot lifecycle: harness-validates + embedder-wires (A) or harness owns full lifecycle (B)? — owner: Radu
- [ ] **Decision 3** — Report-builder skill tools (A) vs strip prompt (B); keep/remove report-pdf & report-pptx — owner: Radu
- [ ] **Decision 4** — Is change 9 (402-resume entry point) still planned? — owner: Radu
- [ ] Author `specs/` deltas for the chosen options; `openspec validate resolve-harness-wiring-gaps --strict` passes

## 1. Decision 1 — Regulatory grounding (per chosen option)

If **B (descope, recommended):**
- [ ] Remove `search_regulatory_guidance` / `find_approval_precedent` call instructions from the four `prompts/target-assessment/briefs/*` files
- [ ] Delete `tools/bio/find-approval-precedent.ts` and its bio-barrel re-export
- [ ] Delete `tasks/regulatory-corpus-boot-refresh.ts`
- [ ] If nothing else consumes it: remove `lib/regulatory-corpus.ts`, the `cortex_regulatory_chunks` table in `state/init.ts`, and the false comment at `state/init.ts:177`
- [ ] `tsc` + `bun test` clean

If **A (build):** split into its own spec-driven change — new `regulatory-grounding` capability, implement `search_regulatory_guidance` over `cortex_regulatory_chunks`, add a tool-calling synthesis pass, roster `find_approval_precedent`, wire the corpus boot refresh, apply corpus filtering.

## 2. Decision 2 — Boot lifecycle & observability (per chosen option)

If **A (recommended):**
- [ ] Thread `skillsDir` into `assembleCoreRuntime` and call `validateAgentSkills(skillsDir, catalog)` at assembly (fail-fast) — satisfies the `agent-skill-assignment` boot-validation requirement
- [ ] Export the shutdown / lifecycle / otel handles from the barrel; document the embedder wiring them into process signals in `CLAUDE.md`/`CONTEXT.md`
- [ ] Fix `lib/otel.ts` doc: the embedder calls `initOtel`, not `index.ts` (correct the stale "called explicitly from index.ts" claim)
- [ ] Reconcile `structured-logging` / `harness-durable-runtime` specs with the chosen ownership
- [ ] `tsc` + `bun test` clean; a `meta.skills` typo now fails at boot (test)

## 3. Decision 3 — Report-builder skills (per chosen option)

If **A (recommended):**
- [ ] Wire `createSkillTools({ skillsDir, skills: ["report-html"] })` into the report-builder roster (`execution/report-runner.ts`)
- [ ] Update the `iterative-report` spec to state report-builder has skill-tool access
If **B:** strip the `skill_search`/`skill_read` guidance from `prompts/report-builder.ts`
- [ ] Keep or remove `skills/report-pdf` + `skills/report-pptx` per the roadmap answer; update `skills/README.md`

## 4. Decision 4 — 402-resume path (per chosen option)

- [ ] If change 9 is live: add a tracking note by `prepareExecuteAnalysisResume` pointing at change 9 so it does not read as dead code
- [ ] If abandoned: delete `workflows/resume-execute-analysis.ts` (+ test) and the 402-pause `attempt_count` bump it serves

## 5. Close-out

- [ ] Update `CLAUDE.md`/`CONTEXT.md` for whatever landed
- [ ] `openspec archive resolve-harness-wiring-gaps` after implementation
