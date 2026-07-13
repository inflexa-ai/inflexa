# Tasks — resolve audited harness wiring gaps

Decisions are resolved (see `design.md`). Remaining open items are called out
per decision. `openspec validate resolve-harness-wiring-gaps --strict` passes.

## 0. Decisions — RESOLVED

- [x] **Decision 1** — Regulatory grounding: remove references to the tool that
  does not exist (`search_regulatory_guidance`); keep `find_approval_precedent`
  (the tool exists) pending a wiring call.
- [x] **Decision 2** — Boot lifecycle: the harness owns an ordered boot sequence
  (`bootHarness`), `assembleCoreRuntime` stays pure; embedder wires the shutdown
  handle + its own telemetry.
- [x] **Decision 3** — Report-builder gets `report-html` skill tools (option A).
- [x] **Decision 4** — "Change 9" (the 402-resume entry point) does not exist in
  this repo; the resume module is coherent but unreachable. Retire-vs-keep left
  to the owner; the phantom "change 9" reference was corrected.

## 1. Decision 1 — Regulatory grounding

- [x] Remove `search_regulatory_guidance` call instructions from the four
  `prompts/target-assessment/briefs/*` files
- [x] Correct the false `state/init.ts` comment (no such tool is wired; point at
  the real corpus files)
- [ ] **Open — `find_approval_precedent` wiring** (the tool exists, unrostered).
  The synthesis path (`structured-llm.ts`) is deliberately single-shot forced-
  `submit` and cannot call any tool, so this is NOT a one-line roster add.
  Options: (A) a deterministic pre-synthesis retrieval step that injects
  precedent results into the brief prompt (keeps single-shot; ~medium), or (B)
  reintroduce a tool-calling agent pass for the briefs (~larger). Until wired,
  the `find_approval_precedent` instructions in the briefs are also unsatisfiable.

## 2. Decision 2 — Boot sequence

- [x] `runtime/boot.ts` `bootHarness` — ordered steps (telemetry → validate
  skills → state init → connection budget → assemble → beforeLaunch → launch);
  returns `{ runtime, shutdown }`; boot-step errors propagate
- [x] Barrel export `bootHarness` + `BootHarnessDeps` / `BootedHarness`
- [x] `runtime/boot.test.ts` — fail-fast on bad skillsDir before pool/launch; telemetry init runs first
- [x] Telemetry kept injectable (default no-op) so the CLI's own OTel is not double-initialized (would print a banner into the TUI)
- [ ] **Open — CLI adoption.** `cli/src/modules/harness/runtime.ts` still hand-rolls the sequence (7 seams). Collapse to one `bootHarness` call (sweep + agent-switch + crons in `beforeLaunch`; `initTelemetry: () => {}`; `exit: () => {}`); route the shutdown hook through `booted.shutdown`. Deferred: outward-facing lifecycle refactor (instance lock, ingress, shutdown ordering) — needs a `bun run dev` smoke test, not just tsc.

## 3. Decision 3 — Report-builder skills — DONE

- [x] `skillsDir` threaded `ConversationAgentDeps` → `IterateReportDeps` → `ReportRunnerDeps`
- [x] `createSkillTools({ skillsDir, skills: ["report-html"] })` wired into the report-builder roster (`execution/report-runner.ts`)
- [x] CLI supplies `skillsDir` to the conversation deps; verified end-to-end (CLI `tsc` clean of harness errors after `dist` rebuild)
- [x] `iterative-report` spec delta: report-builder has `report-html` skill-tool access
- [x] Removed the orphan `skills/report-pdf` + `skills/report-pptx` packs (no agent, no roster, no PDF/PPTX render path referenced them); updated the `skills/` README and added an `agent-skill-assignment` pack-inventory delta (23 → 21 packs)

## 4. Decision 4 — 402-resume path

- [x] Verified: `prepareExecuteAnalysisResume` is coherent internal-contract code, but unreachable (no caller, not on the barrel); "change 9" is phantom (this repo names changes by dated kebab, never numerically)
- [x] Corrected the phantom "change 9" doc references to state the entry point is unbuilt
- [ ] **Open** — retire the resume scaffolding, or build the entry point, per roadmap

## 5. Close-out

- [ ] Land the CLI boot adoption (Decision 2) + decide `find_approval_precedent` wiring (Decision 1)
- [ ] `openspec archive resolve-harness-wiring-gaps` once the open items are closed
