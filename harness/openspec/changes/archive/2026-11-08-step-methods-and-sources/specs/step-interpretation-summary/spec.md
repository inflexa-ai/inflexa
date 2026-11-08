## ADDED Requirements

### Requirement: The host writes the methods and sources of a step

The parent MUST give each child the grounding of its plan step. The parent MUST also give the claim views that match the claims and the snapshot digest of that grounding. After the summarizer, inside the checkpointed step of the summary, the host MUST read the decision records of the step from `output/decision_record_*.json`. The read MUST refuse a file that resolves out of the step directory. It MUST also refuse a file past the size bound, and a file that does not parse. The host MUST then build the methods of the step:

- the grounding status and the snapshot digest
- one template entry for each record, with the method, the environment match, and the script path
- the claims of the grounding, then the claims of the records, with the title and the strength of the view when the plan kept one
- one source for each DOI, PubMed id, or URL of the record citations and of the view evidence
- the license of the rule text.

The claim list and the source list MUST be bounded, and each MUST count its tail. When a step has no grounding, no claim, and no record, the step MUST have no methods. The host MUST append the methods block to the summary markdown after a horizontal rule. The step MUST emit one `data-step-methods` part with the methods, beside the `data-step-summary` part. The part MUST be persistent and not reconciling.

#### Scenario: A grounded step with a decision record

- **GIVEN** a step whose grounding cites `R-0028@d560` with a view, and whose record names `tpl-edger-ql@1.8.0` and one DOI
- **WHEN** the summary step runs
- **THEN** `summary.md` ends with the methods block, which names the template, the method, the rule title, and the DOI
- **AND** the step emits one `data-step-methods` part with the same methods

#### Scenario: The agent deleted its decision record

- **GIVEN** a grounded step with no decision record on disk
- **WHEN** the summary step runs
- **THEN** the methods carry the claims of the grounding and the sources of their views, and no template entry

#### Scenario: A record is a symlink out of the step

- **GIVEN** `output/decision_record_x.json` is a symlink to a file outside the step directory
- **WHEN** the host reads the records
- **THEN** the host leaves the file out and reads nothing through it

## MODIFIED Requirements

### Requirement: StepSummary object shape

`StepSummary` SHALL consist of three string fields — `stepId`, `agentId`,
and `markdown` — and the optional `methods` object, defined by `StepSummarySchema` and produced via
`StepSummarySchema.parse`. The `markdown` body SHALL carry the agent's full
free-form prose (headings, bullets, inline code as it chooses), followed by the methods block when `methods` is present. No structured
findings/evidence/quality fields SHALL be persisted or validated beyond these fields. The host MUST build `methods`. The agent MUST NOT write it.

#### Scenario: Markdown summary object shape

- **WHEN** the summarizer produces a non-empty result
- **THEN** `StepSummarySchema.parse({ stepId, agentId, markdown })` yields an object with exactly those three fields
- **AND** the `markdown` body is the agent's verbatim final text when the step has no methods

#### Scenario: The markdown body is not structurally validated

- **WHEN** the summary is produced
- **THEN** no schema is applied to the internal structure of the markdown — any well-formed string passes

### Requirement: summary.md is written by plain writeFile and is non-fatal

`generateStepSummaryAndWrite` SHALL persist a non-empty summary to
`output/summary.md` under the step's write prefix using the Node `writeFile`
(`node:fs/promises`), creating the `output` directory if needed. A write failure
SHALL be logged as a warning and SHALL NOT fail the step; the summary SHALL still
be returned for vector indexing. For an empty/whitespace summary, a summary-loop
throw, or no final text, the host MUST log a warning and bump `incrementSummaryNullCount`. When the step has methods, the summary MUST then be the methods block alone, and the workflow MUST write it. When the step has no methods, the result MUST be `undefined` with no file written. In each case the workflow MUST
continue.

#### Scenario: summary.md written on non-empty markdown

- **WHEN** the summarizer returns non-empty markdown
- **THEN** the workflow writes it to `output/summary.md` via `writeFile`

#### Scenario: Empty or failed summary is non-fatal

- **WHEN** the summarizer returns `undefined` (empty text, a loop throw, or no final text) for a step with no methods
- **THEN** no `summary.md` is written, a warning is logged with the step id and agent id, `incrementSummaryNullCount` is bumped, and the step is not marked failed

#### Scenario: A failed summary of a grounded step

- **WHEN** the summarizer returns `undefined` for a step with a grounding
- **THEN** `summary.md` holds the methods block alone, and the step is not marked failed

#### Scenario: Write failure is non-fatal

- **WHEN** writing `output/summary.md` throws
- **THEN** the failure is logged as a warning and the step is not marked failed
