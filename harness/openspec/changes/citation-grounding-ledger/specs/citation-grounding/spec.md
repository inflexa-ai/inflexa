# citation-grounding Specification

## ADDED Requirements

### Requirement: The citation ledger records identifiers from tool results

The harness MUST give a citation ledger factory, `createCitationLedger()`, in `harness/src/citations/ledger.ts`. A ledger MUST expose `add(pmids)` and `has(pmid)`. The module MUST also give an extraction helper that walks a tool-result value. The helper MUST collect a value whose key is `pmid` (case-insensitive) and whose text fits the PMID format. Inside a plain string, the helper MUST collect only a `PMID: <digits>` contextual match. The helper MUST NOT collect a bare number, because years and counts would then enter the ledger.

#### Scenario: Field-aware extraction

- **WHEN** the extractor walks a tool result that holds `{ "pmid": "12345678" }` at any depth
- **THEN** the extraction result contains `12345678`

#### Scenario: Contextual extraction from text

- **WHEN** the extractor walks a string value that contains `PMID: 23456789`
- **THEN** the extraction result contains `23456789`

#### Scenario: A bare number is not collected

- **WHEN** the extractor walks a string value that contains `2023` or `n=1500` with no `pmid` key and no `PMID:` prefix
- **THEN** the extraction result contains neither number

### Requirement: The run-synthesizer gate accepts only a grounded PMID

The run-synthesizer loop MUST hold one citation ledger per `generateRunSynthesis` call. The embedded `literature_reviewer` tool MUST record into that ledger. The semantic validation of `validate_synthesis` and `submit_synthesis` MUST reject a `findings[].references[].pmid` or a `keyReferences[].pmid` that the ledger does not hold. The rejection issue MUST name each ungrounded PMID, and its hint MUST point the agent at `literature_reviewer`. The synthesis-agent prompt MUST state that this gate is mechanical.

#### Scenario: An invented PMID is rejected

- **WHEN** the synthesizer submits a finding reference with a PMID that no tool result of the loop carried
- **THEN** `submit_synthesis` returns `{ accepted: false, issues }` and one issue names that PMID as ungrounded

#### Scenario: A PMID copied from a step summary is rejected

- **WHEN** a step summary in the loop input carries a PMID and the synthesizer cites it without a `literature_reviewer` delegation
- **THEN** the submission is rejected, and the hint tells the agent to confirm the PMID through `literature_reviewer`

#### Scenario: A grounded PMID is accepted

- **WHEN** the synthesizer cites a PMID that a `literature_reviewer` call surfaced from its inner tool results
- **AND** the payload passes each other validation
- **THEN** `submit_synthesis` returns `{ accepted: true }`

### Requirement: The analogical reasoner can resolve a citation

`createGenerateAnalogyReportTool` MUST take a `citationResolver` dependency, and `reasonerTools` MUST include the `resolve_citation` tool. The analogical-reasoner prompt MUST name the tool for the verification of a citation identity, not for topical discovery.

#### Scenario: Tool inventory of the reasoner

- **WHEN** the analogical-reasoner agent definition is inspected
- **THEN** its tool array contains `resolve_citation` next to the cross-domain search tools

#### Scenario: The conversation agent wires the resolver

- **WHEN** `createConversationAgent` builds the analogy-report tool
- **THEN** it passes the same `CitationResolver` that its own `resolve_citation` tool uses

### Requirement: The target-assessment critique can resolve a citation

`ExecuteTargetAssessmentDeps` MUST carry a `citationResolver`, and the critique tool set MUST include the `resolve_citation` tool next to the PubMed tool. `assembleCoreRuntime` MUST pass the resolver that it builds, in the same way as `usageRecorder`. The critique prompt MUST name the tool as the way to confirm a cited reference.

#### Scenario: Tool inventory of the critique

- **WHEN** the critique agent loop is built inside the target-assessment investigation
- **THEN** its tool array contains `resolve_citation` and the PubMed tool

#### Scenario: The composition root wires the resolver

- **WHEN** `assembleCoreRuntime` registers the target-assessment workflow
- **THEN** the workflow deps carry the `CitationResolver` that the runtime built
