# Tasks: add-step-handoff-briefings

## 1. Briefing definition

- [x] 1.1 Create `src/prompts/briefings/step-handoff.ts`: `StepHandoffInput` type (`stepId`, `name`, `summaryMarkdown`, `artifactPaths` as sandbox-canonical absolute paths) and the `stepHandoffBriefing: BriefingDefinition<StepHandoffInput>` with `mode: "standing"`, pure `render` embedding the summary verbatim followed by the artifact locations, and caption `step {stepId} "{name}" · {n} artifact{s}`; export from `src/prompts/briefings/index.ts`
- [x] 1.2 Create the colocated fixture `src/prompts/briefings/step-handoff.fixture.ts` (an upstream step with a realistic summary markdown body and 4 artifact paths, `output/summary.md` excluded)
- [x] 1.3 Create `src/prompts/briefings/step-handoff.test.ts`: snapshot test rendering the fixture (content + caption), determinism test (two renders identical), caption pluralization (`1 artifact` vs `n artifacts`), and an assertion that no host path appears in the content

## 2. Parent projection (executeAnalysis + execute_plan)

- [x] 2.1 Add `nameByStepId: Readonly<Record<string, string>>` to `ExecuteAnalysisInput` in `src/workflows/execute-analysis.ts` (optional-with-empty-default so older persisted inputs replay) and populate it in `src/tools/execute-plan.ts` alongside the existing `promptByStepId`/`agentByStepId` projections
- [x] 2.2 Extend `buildChildInput` to derive `handoffSources: readonly { stepId: string; name: string }[]` from the step's `depends_on` (in array order) and `nameByStepId`; add it to `SandboxStepInput` in `src/workflows/sandbox-step.ts` (optional, defaulting to empty)
- [x] 2.3 Extend the `buildChildInput` projection tests in `src/workflows/execute-analysis.test.ts`: `handoffSources` order matches `depends_on`, empty for root steps, and name falls back sensibly when `nameByStepId` lacks an entry

## 3. Child-workflow composition

- [x] 3.1 Implement the `handoff.load` durable step in the `sandbox-step` body (before `runAgent`): for each `handoffSources` entry, read `runs/{runId}/{upstreamStepId}/output/summary.md` via `deps.workspaceFs` and list the upstream step's artifact files (reusing the `walkStepArtifacts` traversal), mapping to `StepHandoffInput[]` with absent-summary entries dropped and paths rendered sandbox-canonical; non-fatal on failure (log, return `[]`)
- [x] 3.2 Compose the briefings purely after the checkpoint (`composeBriefing(stepHandoffBriefing, input)` per entry) and change `initial` to `[...handoffMessages, { role: "user", content: input.prompt }]`
- [x] 3.3 Tests: dependent step's initial messages carry one wrapped `<briefing name="step-handoff">` user message per summarized upstream ahead of the prompt; root step gets prompt-only; summary-less upstream omitted while its sibling survives; `handoff.load` throw degrades to prompt-only without failing the step

## 4. Replace the ad-hoc channel

- [x] 4.1 Rewrite "Orient First" step 5 in `src/prompts/sandbox-standards.ts`: upstream step results arrive in `<briefing name="step-handoff">` blocks — do not re-discover them; keep `read_file` deep inspection of specific referenced artifacts; add the one-sentence `<briefing>` trust statement to the sandbox orientation prompt
- [x] 4.2 Verify `renderStepPrompt` and its field partition are untouched (the existing field-coverage guard test in `src/schemas/` still pins design-time-only rendering); update any prompt snapshot tests broken by 4.1

## 5. Verification

- [x] 5.1 `tsc -p tsconfig.json` passes
- [x] 5.2 `bun test` passes (new briefing, projection, and composition tests included)
- [x] 5.3 `bun run format:file` on every changed file under `src/`
