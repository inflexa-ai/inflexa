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

`StepSummary` SHALL consist of exactly three string fields — `stepId`, `agentId`,
and `markdown` — defined by `StepSummarySchema` and produced via
`StepSummarySchema.parse`. The `markdown` body SHALL carry the agent's full
free-form prose (headings, bullets, inline code as it chooses); no structured
findings/evidence/quality fields SHALL be persisted or validated beyond the three
string fields.

#### Scenario: Markdown summary object shape

- **WHEN** the summarizer produces a non-empty result
- **THEN** `StepSummarySchema.parse({ stepId, agentId, markdown })` yields an object with exactly those three fields
- **AND** the `markdown` body is the agent's verbatim final text

#### Scenario: The markdown body is not structurally validated

- **WHEN** the summary is produced
- **THEN** no schema is applied to the internal structure of the markdown — any well-formed string passes

### Requirement: A dedicated step-summary-writer sub-agent generates the summary

`generateStepSummary` SHALL run a `runAgent` loop for a sub-agent whose id is
`"step-summary-writer"`, derived from the step session via `forSubAgent(session,
"step-summary-writer")`. The loop SHALL be offered exactly one tool —
`createReadFileTool(workspaceFs, workingDir)` scoped to the step's writable output
tree — and SHALL run with `maxIterations` defaulting to `DEFAULT_MAX_ITERATIONS =
12`. The transcript SHALL be the step's in-memory `runAgent` `messages` array
passed in by the workflow body (per the no-workflow-message-store rule; see the
harness-working-memory spec), sanitized to drop any trailing open `tool_use`, and
the loop SHALL run with `passthroughStep` durability and a no-op `emit`. The
summary text SHALL be the final assistant text of that loop.

#### Scenario: Summary loop runs with read_file enabled

- **WHEN** `generateStepSummary` runs
- **THEN** the writer agent has `id: "step-summary-writer"`, its only tool is the scoped `read_file`, and `maxIterations` is `12` unless overridden
- **AND** the loop is driven with `passthroughStep` over the supplied in-memory transcript, not a memory thread

#### Scenario: Trailing open tool_use is sanitized from the transcript

- **GIVEN** the supplied transcript ends with an assistant message carrying an unanswered `tool_use`
- **WHEN** the summarizer prepares the transcript
- **THEN** that trailing partial round is dropped before the summary user-prompt is appended

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
be returned for vector indexing. An empty/whitespace summary, a summary-loop
throw, or no final text SHALL yield `undefined` (logged, and
`incrementSummaryNullCount` bumped) with no file written, and the workflow SHALL
continue.

#### Scenario: summary.md written on non-empty markdown

- **WHEN** the summarizer returns non-empty markdown
- **THEN** the workflow writes it to `output/summary.md` via `writeFile`

#### Scenario: Empty or failed summary is non-fatal

- **WHEN** the summarizer returns `undefined` (empty text, a loop throw, or no final text)
- **THEN** no `summary.md` is written, a warning is logged with the step id and agent id, `incrementSummaryNullCount` is bumped, and the step is not marked failed

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

### Requirement: Sandbox standards teach literature grounding during execution

`sandbox-standards` SHALL instruct sandbox agents to ground findings in the
research literature **as they work** — searching PubMed (`search_pubmed`),
pulling abstracts (`get_article_details`), and assessing novelty per finding
during the main execution turns — rather than deferring it to a final step. The
post-step summary turn SHALL NOT be the place literature search happens; it
grounds claims in persisted files via `read_file`.

#### Scenario: Agent searches literature while working

- **WHEN** a sandbox agent identifies a significant finding during its main analysis turns
- **THEN** the standards direct it to search PubMed for related prior work at that point, not in the summary turn

#### Scenario: Summary turn does not search literature

- **WHEN** the post-step summary turn runs
- **THEN** its only tool is `read_file`; it does not call `search_pubmed` or `get_article_details`
