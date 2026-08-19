# literature-reviewer Delta

## MODIFIED Requirements

### Requirement: Sub-agent packaged as a tool

The harness MUST expose the `literature-reviewer` as a sub-agent in the shape of a tool. Its `execute` MUST call `runAgent` with a focused agent definition. The child `Session` MUST come from `forSubAgent(parentSession, "literature-reviewer")`.

The factory `createLiteratureReviewerTool(deps)` lives at `harness/src/tools/research/literature-reviewer.ts`. It captures its `ChatProvider`, model id, and `bioKeys` dependencies. The child loop uses `passthroughStep`, because the tool call of the parent is the durable step. The tool MUST return `ok({ report })`, where `report` is the final text of the child transcript.

The factory MUST also accept an optional `citationLedger` dependency. When the ledger is present, the tool MUST extract the PMIDs from the `tool-result` parts of the inner transcript. This extraction runs after the child loop returns, and the tool MUST record the PMIDs into the ledger. The prose report MUST NOT be a ledger source, because the report is model text.

#### Scenario: Tool creation

- **WHEN** `createLiteratureReviewerTool(deps)` runs
- **THEN** the returned `Tool` has the on-wire id `literature_reviewer`
- **AND** `execute(input, ctx)` runs `runAgent` over the sub-agent definition, with a session from `forSubAgent`

#### Scenario: Child transcript is ephemeral

- **WHEN** the literature-reviewer tool completes
- **THEN** no store persists the working message array of the child (the sub-agent delegation rule of the harness-agent-loop spec)
- **AND** the parent loop sees only the `ok({ report })` return value of the tool

#### Scenario: Ledger contribution from the inner transcript

- **WHEN** the tool runs with a `citationLedger` and an inner tool result carries a PMID
- **THEN** the ledger holds that PMID after the tool returns

#### Scenario: A report-only PMID stays out of the ledger

- **WHEN** the final report of the child names a PMID that no inner tool result carried
- **THEN** the ledger does not hold that PMID

### Requirement: submit_synthesis validates and is re-callable; no-terminal throws

`submit_synthesis` MUST validate the submitted payload again, against `RunSynthesisSchema` plus the semantic validations. The semantic validations are:

- the runId match
- the stepId references
- the theme-to-finding references
- the keyReferences citation rule
- the numeric PMID format
- the citation-ledger grounding, per the `citation-grounding` spec

On success the tool returns `{ accepted: true }`. On rejection it returns `{ accepted: false, issues }`, and the agent can correct the cited issue paths and call again.

When the loop ends without a terminal tool call, `runToTerminal` MUST grant one salvage continuation. The tools of that continuation are only the terminal tools. If the continuation also ends without a terminal tool call, `generateRunSynthesis` MUST throw.

A genuine synthesis failure MUST re-throw out of `synthesizeRun`, after a `failed` progress phase. Thus the run fails loudly. Only the honest non-fatal outcomes return empty findings after a `skipped` phase. Those outcomes are the no-step-summaries condition and a `report_blocker` call.

#### Scenario: Rejected submission is fixed and resubmitted

- **WHEN** `submit_synthesis` returns `{ accepted: false, issues }`
- **THEN** the agent corrects the fields at the cited issue paths and calls `submit_synthesis` again

#### Scenario: An ungrounded PMID is a rejection

- **WHEN** the payload cites a PMID that the citation ledger does not hold
- **THEN** `submit_synthesis` returns `{ accepted: false, issues }` and one issue names that PMID

#### Scenario: Blocker is a non-fatal skip

- **WHEN** the synthesizer calls `report_blocker`
- **THEN** `synthesizeRun` reports a `skipped` phase with the blocker reason and returns empty findings

#### Scenario: No terminal call fails the run

- **WHEN** the loop and its salvage continuation both end without a terminal tool call
- **THEN** `generateRunSynthesis` throws
- **AND** `synthesizeRun` re-throws, and the run fails loudly
