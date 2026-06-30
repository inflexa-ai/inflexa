# literature-reviewer Specification

## Purpose

Defines the `literature-reviewer` sub-agent — packaged as a regular tool whose
`execute` runs a child `runAgent` loop over a focused bio-lookup tool surface and
a derived child `Session`. It is delegation-as-a-tool: the conversation agent
calls it for batch literature/biology research, and the run-synthesizer agent
embeds it as its only research path during literature-grounded run synthesis.

Run synthesis is itself an agentic loop, not a fixed pipeline. The
`run-synthesizer` agent (`harness/src/execution/run-synthesis.ts`,
`generateRunSynthesis`) is driven through `runToTerminal` and reaches the user
only by calling a terminal tool: `submit_synthesis` (schema + semantic
validation, re-callable on rejection), `report_blocker` (nothing synthesizable),
or by delegating to `literature_reviewer`. The host-agnostic `synthesizeRun`
service (`harness/src/app/synthesize-run.ts`) loads the run's step summaries,
drives that loop under a `forSubAgent(session, "run-synthesizer")` session, then
indexes and persists the result. Teaching for both agents lives in `prompts/` —
the reviewer's own conventions and tool-argument rules in
`harness/src/prompts/literature-reviewer.ts`, the synthesizer's terminal-tool
discipline in `harness/src/prompts/synthesis-agent.ts`.

## Requirements

### Requirement: Sub-agent packaged as a tool

The `literature-reviewer` SHALL be a sub-agent exposed as a tool whose `execute`
calls `runAgent` with a focused agent definition and a child `Session` derived
via `forSubAgent(parentSession, "literature-reviewer")`. The factory
`createLiteratureReviewerTool(deps)` lives at
`harness/src/tools/research/literature-reviewer.ts` and captures its
`ChatProvider`, model id, and `bioKeys` dependencies. The child loop uses
`passthroughStep` because the parent's tool call is the durable step. The tool
SHALL return `ok({ report })` where `report` is the child transcript's final
text.

#### Scenario: Tool creation

- **WHEN** `createLiteratureReviewerTool(deps)` is invoked
- **THEN** the returned `Tool` has on-wire id `literature_reviewer`
- **AND** invoking `execute(input, ctx)` runs `runAgent` against the sub-agent definition with a session derived via `forSubAgent`

#### Scenario: Child transcript is ephemeral

- **WHEN** the literature-reviewer tool completes
- **THEN** the child's working message array is not persisted anywhere (the harness-agent-loop spec's sub-agent delegation rule)
- **AND** the parent loop sees only the tool's `ok({ report })` return value

### Requirement: Bio-lookup tool surface

The literature reviewer agent SHALL be configured with a focused bio-lookup tool
surface only — no workspace tools, no sandbox tools, no memory tools.

#### Scenario: Tool inventory

- **WHEN** inspecting the literature-reviewer agent definition
- **THEN** its `tools` array contains exactly the bio-lookup tools assembled into the local `reviewerTools` const: `searchGene`, `searchPathway`, `lookupGoTerm`, `searchInteractions`, `searchPubMed`, `getArticleDetails`, `getArticleFullText`, `searchDgidb`, `searchBgeeExpression`, `getImpcKoProfile`

#### Scenario: No workspace or memory tools

- **WHEN** inspecting the literature-reviewer agent definition
- **THEN** the tool list contains no workspace tools (`read_file`, `grep`, `workspace_search`)
- **AND** no memory tools (`updateWorkingMemory`)

### Requirement: Bounded iteration budget

The literature-reviewer agent definition SHALL set `maxIterations` to 30
(`REVIEWER_MAX_ITERATIONS`) to bound the multi-tool research budget (search →
read → synthesize over many genes).

#### Scenario: Iteration budget

- **WHEN** inspecting the agent definition
- **THEN** `maxIterations` is `30`

### Requirement: Sub-agent identity flows via callPath

The child's `callPath` SHALL extend the parent's via `forSubAgent`, and the
literature reviewer's `agentId` SHALL be `"literature-reviewer"`. The child's
session continues to carry the parent's scope and identity — only the agent
provenance changes; the parent session is left unmutated.

#### Scenario: callPath extends parent

- **GIVEN** a parent session whose `provenance.callPath = ["conversation-agent"]`
- **WHEN** the literature-reviewer tool runs
- **THEN** the child session's `provenance.callPath` is `["conversation-agent", "literature-reviewer"]`
- **AND** `provenance.agentId` is `"literature-reviewer"`

### Requirement: Anti-patterns are explicitly forbidden in the prompt

The agent's system prompt (`harness/src/prompts/literature-reviewer.ts`) SHALL
include a "Do NOT" section listing prohibited behaviors.

#### Scenario: No fabrication

- **WHEN** a tool search returns no results
- **THEN** the agent reports that no results were found rather than fabricating information

#### Scenario: No skipping tool calls

- **WHEN** the agent has a target to investigate
- **THEN** it uses the appropriate tools to look it up rather than claiming prior knowledge

#### Scenario: No scope creep

- **WHEN** the agent encounters interesting leads outside the research brief
- **THEN** it notes them for follow-up but does not investigate them

### Requirement: Run synthesis is the agentic run-synthesizer loop

Run synthesis SHALL run as the agentic `run-synthesizer` loop
(`generateRunSynthesis` in `harness/src/execution/run-synthesis.ts`), driven
through `runToTerminal` over `passthroughStep`, with system prompt
`synthesis-agent.ts`, agent id `run-synthesizer`, and `maxIterations` 25. Its
tool surface SHALL be exactly
`submit_synthesis`, `report_blocker`, and the embedded `literature_reviewer`
sub-agent tool. The host-agnostic `synthesizeRun` service
(`harness/src/app/synthesize-run.ts`) SHALL load the run's step summaries, build
the prompt from the step summaries and the plan's analytical narrative, drive the
loop under a `forSubAgent(session, "run-synthesizer")` session, then index the
synthesis vector, persist `synthesis.json`, and emit a `data-run-synthesis` chat
part on the happy path.

#### Scenario: Synthesizer reaches the user only via a terminal tool

- **WHEN** the run-synthesizer loop runs
- **THEN** the only way a synthesis or blocker reaches the caller is a `submit_synthesis` or `report_blocker` call
- **AND** the agent's research is performed by delegating briefs to the `literature_reviewer` tool

#### Scenario: Happy-path deliverables

- **WHEN** the synthesizer calls `submit_synthesis` with a payload that passes validation
- **THEN** `synthesizeRun` persists `synthesis.json` to the run directory and emits a `data-run-synthesis` chat part

### Requirement: submit_synthesis validates and is re-callable; no-terminal throws

`submit_synthesis` SHALL re-validate the submitted payload against
`RunSynthesisSchema` plus semantic checks (runId match, stepId references,
theme→finding references, keyReferences cited by a finding, numeric PMIDs),
returning `{ accepted: true }` on success or `{ accepted: false, issues }` on
rejection so the agent can fix the cited issue paths and call again. When the
loop ends without any terminal tool call, `runToTerminal` SHALL grant one salvage
continuation whose tools are only the terminal tools; if it still does not call a
terminal tool, `generateRunSynthesis` SHALL throw. A genuine synthesis failure
SHALL re-throw out of `synthesizeRun` (after a `failed` progress phase) so the
run fails loudly; only the honest non-fatal outcomes — no step summaries, or a
`report_blocker` — return empty findings after a `skipped` phase.

#### Scenario: Rejected submission is fixed and resubmitted

- **WHEN** `submit_synthesis` returns `{ accepted: false, issues }`
- **THEN** the agent corrects the fields at the cited issue paths and calls `submit_synthesis` again

#### Scenario: Blocker is a non-fatal skip

- **WHEN** the synthesizer calls `report_blocker`
- **THEN** `synthesizeRun` reports a `skipped` phase with the blocker reason and returns empty findings

#### Scenario: No terminal call fails the run

- **WHEN** the loop and its salvage continuation both end without a terminal tool call
- **THEN** `generateRunSynthesis` throws and `synthesizeRun` re-throws so the run fails loudly

### Requirement: The reviewer prompt teaches correct tool-argument usage

The literature-reviewer prompt SHALL explicitly teach correct argument usage for
`get_article_details` and `search_interactions`; this teaching lives in
`harness/src/prompts/literature-reviewer.ts`.

#### Scenario: get_article_details pmids required

- **WHEN** the prompt is rendered
- **THEN** it states that `get_article_details` MUST be called with `pmids`, a non-empty array of PMID strings, and never with `{}`

#### Scenario: search_interactions 100-identifier cap

- **WHEN** the prompt is rendered
- **THEN** it states that `search_interactions` accepts at most 100 identifiers per call, so larger gene sets must be batched into calls of ≤100
