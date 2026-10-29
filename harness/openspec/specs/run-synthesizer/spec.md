# run-synthesizer Specification

## Purpose
Defines the `run-synthesizer` agent loop that writes the literature-grounded synthesis of a run: its tools, its own lookups, the checks of `submit_synthesis`, and the selection of its outcome.

## Requirements

### Requirement: Run synthesis is the agentic run-synthesizer loop

Run synthesis MUST run as the agentic `run-synthesizer` loop (`generateRunSynthesis` in `harness/src/execution/run-synthesis.ts`). `runWithSalvage` drives the loop, with the system prompt `synthesis-agent.ts`, the agent id `run-synthesizer`, and `maxIterations` 40. A synthesis or a blocker reaches the caller only through a call of a terminal tool.

#### Scenario: Synthesizer reaches the user only via a terminal tool

- **WHEN** the run-synthesizer loop runs
- **THEN** the only way a synthesis or a blocker reaches the caller is a `submit_synthesis` or `report_blocker` call

#### Scenario: Iteration budget

- **WHEN** a reader inspects the agent definition of the synthesizer
- **THEN** `maxIterations` is `40`

### Requirement: The synthesizer declares its terminal tools, its lookups, and the read tool

The synthesizer MUST declare `submit_synthesis` and `report_blocker`, then `read_tool_output` when the composition has a tool output store. Its lookups MUST be script tools of `run_script`. The synthesizer MUST use the tool output store of the run. It MUST hold no tool that runs a sub-agent.

#### Scenario: The declared tools with a store

- **GIVEN** a synthesizer with a tool output store, no embedding provider, and the lookup `pubmed`
- **WHEN** its first request is sent
- **THEN** the request declares `read_file`, `list_files`, `file_stat`, `grep`, `inspect_data_profile`, `submit_synthesis`, `report_blocker`, `read_tool_output`, and `run_script`, in that order
- **AND** the script tools are `pubmed`, `read_table`, `read_pdf`, and `list_archive`

#### Scenario: The synthesizer reads a long lookup result again

- **GIVEN** a PubMed result of 40,000 characters that the loop of the synthesizer cut
- **WHEN** the synthesizer calls `read_tool_output` with the reference of the excerpt
- **THEN** the call gives a page of the result

### Requirement: The synthesizer reads the workspace and writes nothing

The synthesizer MUST declare the read tools of the workspace before its terminal tools: `read_file`, `list_files`, `file_stat`, `grep`, `workspace_search` when an embedding provider is bound, and `inspect_data_profile`. `read_table`, `read_pdf`, and `list_archive` MUST be script tools. The synthesizer MUST hold no tool that writes. A step summary can omit a fact that a file of the run holds.

#### Scenario: No write tool

- **WHEN** the tools of the synthesizer are resolved
- **THEN** they hold `read_file` and no `write_file` or `edit_file`

### Requirement: The synthesizer looks up its evidence itself

`createSynthesisLookupTools(deps)` (`harness/src/tools/research/synthesis-lookups.ts`) MUST give the synthesizer lookups: `search_gene`, `search_protein`, `lookup_annotation`, `search_interactions`, `pubmed`, `resolve_citation`, `drug_gene_interactions`, and `gene_preclinical_profile`. `assembleCoreRuntime` MUST build them one time, with the bio keys of the embedder and the shared `CitationResolver`.

#### Scenario: The lookup inventory

- **WHEN** `createSynthesisLookupTools` builds the lookups
- **THEN** their ids are exactly `search_gene`, `search_protein`, `lookup_annotation`, `search_interactions`, `pubmed`, `resolve_citation`, `drug_gene_interactions`, and `gene_preclinical_profile`

#### Scenario: The runtime passes the lookups to the synthesis

- **WHEN** `assembleCoreRuntime` registers the run workflow
- **THEN** `ExecuteAnalysisDeps.synthesisLookups` holds the lookups, and `synthesizeRun` gives them to `generateRunSynthesis`

### Requirement: submit_synthesis refuses a PMID that no lookup of the run returned

Each lookup MUST record the PMIDs of its ok result: each value under a `pmid` or `pmids` key, at any depth, outside the keys `input`, `normalized`, `supplied`, and `query`. `submit_synthesis` MUST refuse each numeric PMID in `findings[].references[].pmid` and `keyReferences[].pmid` that no lookup of the run recorded, with the message `pmid "<id>" is in no lookup result of this run`.

#### Scenario: A PMID before its lookup is refused, and the same PMID after its lookup is accepted

- **GIVEN** a synthesizer that made no lookup
- **WHEN** it submits a synthesis that cites the PMID `12345678` in a finding and in `keyReferences`
- **THEN** each of the two paths gets the issue `pmid "12345678" is in no lookup result of this run`
- **AND** after a `pubmed` lookup that returns `12345678`, the same submission is accepted

#### Scenario: The PMIDs at each depth count

- **WHEN** a lookup result holds `pmid` values in its results and a `pmids` list in a nested record
- **THEN** each numeric value counts, and a value that is not numeric does not count

#### Scenario: The echo of a request does not count

- **GIVEN** a `resolve_citation` result whose `input` and `normalized` records hold the PMID `99999999`, and whose source records hold `12345678`
- **WHEN** the lookup records its PMIDs
- **THEN** the record holds `12345678`, and it does not hold `99999999`

#### Scenario: A PMID past the excerpt of a cut result counts

- **GIVEN** a lookup result that the loop cut to an excerpt
- **WHEN** the loop folds the record of the call
- **THEN** the record holds each PMID of the whole result, also a PMID past the excerpt

### Requirement: The PMID record survives a replay

The PMID record of a lookup MUST be a call record of the loop, not a side effect of the body of the tool. The loop MUST fold each record into the set of the run after each round, on the first run and on each replay. Thus `submit_synthesis` reads the same set in both. A lookup that keeps its own call record MUST NOT get the PMID record, and the wrap MUST throw for it.

#### Scenario: A replay folds the PMIDs again

- **GIVEN** a synthesis in a workflow that made a `pubmed` lookup, then an accepted submission that cites a PMID of that lookup, and then stopped
- **WHEN** the run recovers
- **THEN** the lookup gives its result from its checkpoint, and its body does not run again
- **AND** the synthesis outcome is `produced`

#### Scenario: A lookup with its own call record

- **WHEN** the PMID record wraps a lookup that already folds its own call record
- **THEN** the wrap throws an error that names the lookup

### Requirement: The synthesis loop runs in the body of the run workflow

The synthesis of a run MUST run its loop in the workflow body of the run, not inside one step. Each model call and each lookup call of the synthesizer MUST be a step of the run workflow. A recovery of the synthesis MUST NOT run a completed call again.

#### Scenario: A crash during the synthesis

- **GIVEN** a synthesis that completed its model calls and a lookup before the host stopped
- **WHEN** the run recovers
- **THEN** the synthesis gets each model reply and the lookup result from their checkpoints, and the provider gets no request for them

### Requirement: synthesizeRun drives the loop and keeps its result

The host-agnostic `synthesizeRun` service (`harness/src/app/synthesize-run.ts`) MUST load the step summaries of the run. It MUST build the prompt from the step summaries and the analytical narrative of the plan. It MUST drive the loop under a `forSubAgent(session, "run-synthesizer")` session. On success it MUST index the synthesis vector, persist `synthesis.json`, and emit a `data-run-synthesis` chat part.

#### Scenario: Happy-path deliverables

- **WHEN** the synthesizer calls `submit_synthesis` with a payload that passes validation
- **THEN** `synthesizeRun` persists `synthesis.json` to the run directory and emits a `data-run-synthesis` chat part

### Requirement: submit_synthesis checks a synthesis and does not end the run

`submit_synthesis` MUST check the payload against `RunSynthesisSchema` and the semantic checks: the `stepId` references, the theme-to-finding references, the `keyReferences` that a finding cites, numeric PMIDs, and PMIDs that a lookup of the run returned. It gives back the accepted synthesis or the issues. It MUST NOT end the run. The synthesizer has no separate validation tool.

#### Scenario: A refused synthesis is repaired

- **WHEN** `submit_synthesis` gives back issues
- **THEN** the synthesizer corrects the fields at the cited paths and submits again

### Requirement: The host stamps the run id of a synthesis

The model MUST NOT give the `runId` of a synthesis. The input schema of `submit_synthesis` carries no `runId`, and the host stamps the id of its run on the accepted synthesis.

#### Scenario: A synthesis carries the id of its run

- **WHEN** the synthesizer submits an accepted synthesis
- **THEN** the stored synthesis carries the `runId` of the run, and the model never typed it

### Requirement: The synthesis outcome is the last accepted submission

After the run, `generateRunSynthesis` MUST take the last accepted synthesis as the outcome. With none, a blocker gives a non-fatal skip. With neither, one salvage request follows, and only the terminal tools can run in it. When the salvage also gives no outcome, `generateRunSynthesis` MUST throw, and the run fails loudly.

#### Scenario: Blocker is a non-fatal skip

- **WHEN** the synthesizer records a blocker and no accepted synthesis
- **THEN** `synthesizeRun` reports a `skipped` phase with the reason and returns empty findings

#### Scenario: A lookup in the salvage does not run

- **GIVEN** a synthesizer that ended on prose with no accepted synthesis
- **WHEN** it calls `pubmed` in the salvage request
- **THEN** the call gets an error result that names `submit_synthesis` and `report_blocker` as the tools that can run, and the lookup does not run

#### Scenario: No outcome fails the run

- **WHEN** the run and its salvage both end with no outcome
- **THEN** `generateRunSynthesis` throws, and `synthesizeRun` throws again
