## Purpose

Defines how each sandbox step produces a post-step interpretive summary of the
computation it just performed — the object shape, the dedicated sub-agent that
writes it, where the markdown is persisted and indexed, and the turn budget.

The summary is written by a **dedicated `step-summary-writer` sub-agent**, not by
the step's own agent and not as a no-tool memory recall. The reason is the
deliverables contract owned by the harness-sandbox-agents spec: because a step
agent's deliverable is its *persisted files* (and it declares inability via a
blocker rather than improvising an inline stdout result), the transcript is
trustworthy by construction. So the summarizer is given the step's in-memory
transcript for narrative AND a single scoped `read_file` tool, and is instructed
to ground every quantitative claim in a persisted output file rather than lifting
numbers from ephemeral `execute_command` stdout — instead of being blinded with
`tool_choice: none` to fight confabulation. The markdown body is the single
source of truth: it is rendered verbatim by the UI and embedded verbatim into the
per-analysis vector index with `type: "summary"`. Literature grounding is a
separate concern handled by the run-synthesis step, not by this summary turn.

## Requirements

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

### Requirement: Claims are grounded in persisted output files

The summarizer prompt SHALL instruct the agent to open output files with
`read_file` and report only numbers that exist in a persisted artifact — a value
appearing only in command stdout SHALL NOT be reported. When the step produced no
output files, the agent SHALL state that plainly and SHALL NOT synthesize results
no artifact backs.

#### Scenario: A quantitative claim is read from a file

- **WHEN** the agent needs to report a computed number
- **THEN** the prompt directs it to `read_file` the persisted artifact holding that number rather than citing `execute_command` stdout

#### Scenario: Honest empty on no outputs

- **WHEN** the step produced no output files
- **THEN** the summary states the step produced no output files and synthesizes no unbacked results

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

### Requirement: The summary is vector-indexed as type "summary"

When a non-empty summary exists, `vectorIndexStepOutputs` SHALL embed the markdown
and upsert it into the per-analysis vector store with metadata `type: "summary"`
plus `stepId`, `runId`, `agentId`, and the `runs/{runId}/{stepId}/output/summary.md`
path, under id `/{analysisId}/runs/{runId}/{stepId}/output/summary.md`. Indexing
SHALL be best-effort — any failure is logged and swallowed without failing the
step.

#### Scenario: Summary embedded with type summary

- **WHEN** indexing runs for a step with a non-empty summary
- **THEN** the vector entry's metadata `type` is `"summary"` and carries `stepId`, `runId`, `agentId`, and the summary path

#### Scenario: Indexing failure is swallowed

- **WHEN** embedding or upsert throws
- **THEN** the error is logged and the step still completes

### Requirement: The step summary continues the conversation of the step agent

`generateStepSummary` MUST run a continuation of the conversation of the step agent (refer to the harness-agent-loop capability), under the accounting agent id `"step-summary-writer"`. The continuation derives its session through `forSubAgent(session, "step-summary-writer")`. It MUST use the agent definition, the provider, and the transcript of the task. When a file-metadata exchange exists, the conversation MUST also hold the messages of that exchange.

The continuation MUST use a cap of 12 requests. Its mask MUST let only `read_file`, `grep`, and `read_tool_output` run. The three are declared tools of the step agent, and the two file tools resolve a path against the step directory. `read_tool_output` reads the rest of a `read_file` result that the loop cut. The continuation MUST run with the tool output store of the task.

Its request MUST be the summary instructions and the list of the output files. It runs with a no-op `emit`, inside the `DBOS.runStep` wrapper of the stage. Thus each of its calls runs directly, with no step of its own. The summary text MUST be the final assistant text of the continuation.

The transcript is the in-memory `runLoop` `messages` array of the workflow body, as the no-workflow-message-store rule states (refer to the harness-working-memory spec). The loop answers each unanswered call of the task at its exit. Thus the continuation gets a valid transcript, and it removes no message from it.

#### Scenario: The summary continuation lets only the read tools run

- **WHEN** `generateStepSummary` runs
- **THEN** the continuation sends the system prompt and the tools of the step agent, and its cap is 12
- **AND** its mask lets only `read_file`, `grep`, and `read_tool_output` run
- **AND** each usage record of the continuation carries the `agentId` `step-summary-writer`

#### Scenario: The transcript reaches the request unchanged

- **GIVEN** a transcript whose last assistant message carried a tool call that the loop answered with the not-run result
- **WHEN** the summary continuation sends its request
- **THEN** the request holds each message of the transcript unchanged, and the summary request comes after them

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
