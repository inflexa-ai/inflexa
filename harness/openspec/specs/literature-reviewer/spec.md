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

The literature reviewer agent MUST have a focused bio-lookup tool surface and `read_tool_output`. It MUST have no workspace tools, no sandbox tools, and no memory tools. `read_tool_output` reads the kept text of a lookup result that the loop cut (refer to the harness-tools capability). It is not a workspace tool, because it reads the tool output store and no file.

#### Scenario: Tool inventory

- **WHEN** a reader inspects the agent definition of the literature reviewer
- **THEN** its `tools` array contains exactly the bio-lookup tools of the local `reviewerTools` const, and then `read_tool_output`

#### Scenario: No workspace or memory tools

- **WHEN** a reader inspects the agent definition of the literature reviewer
- **THEN** the tool list contains no workspace tools (`read_file`, `grep`, `workspace_search`)
- **AND** no memory tools (`updateWorkingMemory`)

#### Scenario: The reviewer reads the rest of a long lookup

- **GIVEN** a reviewer whose PubMed search gives a result of 60,000 characters
- **WHEN** the reviewer calls `read_tool_output` with the reference of the excerpt
- **THEN** the call gives a page of the kept text

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

Run synthesis MUST run as the agentic `run-synthesizer` loop (`generateRunSynthesis` in `harness/src/execution/run-synthesis.ts`). `runToTerminal` drives the loop over `passthroughStep`, with the system prompt `synthesis-agent.ts`, the agent id `run-synthesizer`, and `maxIterations` 25.

Its tool surface MUST be exactly `validate_synthesis`, `submit_synthesis`, `report_blocker`, the embedded `literature_reviewer` sub-agent tool, and `read_tool_output`. The synthesizer and the embedded reviewer MUST use the tool output store of the run.

The host-agnostic `synthesizeRun` service (`harness/src/app/synthesize-run.ts`) MUST load the step summaries of the run. It MUST build the prompt from the step summaries and the analytical narrative of the plan. It MUST drive the loop under a `forSubAgent(session, "run-synthesizer")` session. On success it MUST index the synthesis vector, persist `synthesis.json`, and emit a `data-run-synthesis` chat part.

#### Scenario: Synthesizer reaches the user only via a terminal tool

- **WHEN** the run-synthesizer loop runs
- **THEN** the only way a synthesis or a blocker reaches the caller is a `submit_synthesis` or `report_blocker` call
- **AND** the agent does its research through briefs to the `literature_reviewer` tool

#### Scenario: Happy-path deliverables

- **WHEN** the synthesizer calls `submit_synthesis` with a payload that passes validation
- **THEN** `synthesizeRun` persists `synthesis.json` to the run directory and emits a `data-run-synthesis` chat part

#### Scenario: The synthesizer reads a long report again

- **GIVEN** a reviewer report of 40,000 characters that the loop of the synthesizer cut
- **WHEN** the synthesizer calls `read_tool_output` with the reference of the excerpt
- **THEN** the call gives a page of the report

### Requirement: submit_synthesis validates and is re-callable; no-terminal throws

`submit_synthesis` MUST validate the submitted payload again against `RunSynthesisSchema` plus the semantic checks. The checks are the `runId` match, the `stepId` references, the theme-to-finding references, the `keyReferences` that a finding cites, and numeric PMIDs. It MUST return `{ accepted: true }` on success, or `{ accepted: false, issues }` on a rejection. Thus the agent can correct the cited issue paths and call again.

When the loop ends without a terminal tool call, `runToTerminal` MUST run one salvage continuation. The salvage continuation MUST keep the declared tools of the synthesizer, and its mask MUST let only the terminal tools run. If the salvage also ends without a terminal tool call, `generateRunSynthesis` MUST throw.

A synthesis failure MUST throw again out of `synthesizeRun`, after a `failed` progress phase, thus the run fails loudly. Only two non-fatal outcomes return empty findings after a `skipped` phase: no step summaries, and a `report_blocker`.

#### Scenario: Rejected submission is fixed and resubmitted

- **WHEN** `submit_synthesis` returns `{ accepted: false, issues }`
- **THEN** the agent corrects the fields at the cited issue paths and calls `submit_synthesis` again

#### Scenario: Blocker is a non-fatal skip

- **WHEN** the synthesizer calls `report_blocker`
- **THEN** `synthesizeRun` reports a `skipped` phase with the blocker reason and returns empty findings

#### Scenario: No terminal call fails the run

- **WHEN** the loop and its salvage continuation both end without a terminal tool call
- **THEN** `generateRunSynthesis` throws, and `synthesizeRun` throws again, thus the run fails loudly

#### Scenario: The salvage keeps the tools of the synthesizer

- **GIVEN** a synthesizer run that ends without a terminal tool call
- **WHEN** the salvage continuation sends its request
- **THEN** the request declares `literature_reviewer` and the other tools of the synthesizer
- **AND** a call to `literature_reviewer` in the salvage gets the error result of the mask

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

### Requirement: The literature reviewer can verify citations

The literature-reviewer agent's exact tool inventory SHALL include `resolve_citation`, backed by the runtime's shared resolver. Its prompt SHALL distinguish topical discovery from verification, SHALL preserve `inconclusive` and source coverage in its conclusions, and SHALL forbid presenting an outage or weak candidate as proof that a citation is fabricated.

#### Scenario: Reviewer verifies rather than searches by title alone

- **WHEN** the reviewer is asked whether a supplied citation exists and has correct metadata
- **THEN** it can call `resolve_citation` and reason from the returned field comparisons and coverage

#### Scenario: Reviewer retains uncertainty

- **WHEN** resolution returns `inconclusive` with an unavailable source
- **THEN** the reviewer reports the unresolved coverage gap
- **AND** it does not rewrite the verdict as `not_found`

### Requirement: The run synthesis limits the literature reviewer to three calls

`generateRunSynthesis` MUST run the synthesizer with the tool budget `{ literature_reviewer: 3 }` (refer to the harness-agent-loop capability). A fourth call of `literature_reviewer` in the run MUST get an error result that gives the limit, and the sub-agent MUST NOT run. Each delegation runs a full sub-agent loop, and the iteration budget of the synthesizer plans for 1 to 3 delegations for each run. The budget makes that plan a rule of the harness. The prompt of the synthesizer names no count.

#### Scenario: The fourth delegation does not run

- **GIVEN** a synthesizer that delegated 3 briefs to `literature_reviewer`
- **WHEN** it calls `literature_reviewer` a fourth time
- **THEN** the call gets an error result that gives the limit of 3, and no reviewer loop runs

#### Scenario: Three delegations in one round run

- **GIVEN** a synthesizer that calls `literature_reviewer` 3 times in one reply
- **WHEN** the loop dispatches the round
- **THEN** the 3 calls run
