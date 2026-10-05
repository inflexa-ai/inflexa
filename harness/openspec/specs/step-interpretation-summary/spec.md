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

`sandbox-standards` MUST tell sandbox agents to ground their findings in the research literature as they work. The standards direct an agent to search PubMed (`search_pubmed`) and to read abstracts (`get_article_details`). The agent assesses the novelty of each finding during the primary execution turns. The standards MUST NOT defer this work to a final step. The post-step summary continuation MUST NOT search the literature. Its mask lets only `read_file`, `grep`, and `read_tool_output` run, and it grounds claims in persisted files through `read_file`.

#### Scenario: Agent searches literature while working

- **WHEN** a sandbox agent finds a significant result during its primary analysis turns
- **THEN** the standards direct it to search PubMed for related prior work at that point, not in the summary continuation

#### Scenario: Summary turn does not search literature

- **GIVEN** a step agent that declares `search_pubmed`, and a summary continuation whose model calls it
- **WHEN** the loop dispatches the call
- **THEN** the call gets the error result of the mask, and no search runs

### Requirement: The step summary continues the conversation of the step agent

`generateStepSummary` MUST run a continuation of the conversation of the step agent (refer to the harness-agent-loop capability), under the accounting agent id `"step-summary-writer"`. The continuation derives its session through `forSubAgent(session, "step-summary-writer")`. It MUST use the agent definition, the provider, and the transcript of the task. When a file-metadata exchange exists, the conversation MUST also hold the messages of that exchange.

The continuation MUST use a cap of 12 requests. Its mask MUST let only `read_file`, `grep`, and `read_tool_output` run. The three are declared tools of the step agent, and the two file tools resolve a path against the step directory. `read_tool_output` reads the rest of a `read_file` result that the loop cut. The continuation MUST run with the tool output store of the task.

Its request MUST be the summary instructions and the list of the output files. It runs with `passthroughStep` durability and a no-op `emit`, inside the `DBOS.runStep` wrapper of the stage. The summary text MUST be the final assistant text of the continuation.

The transcript is the in-memory `runAgent` `messages` array of the workflow body, as the no-workflow-message-store rule states (refer to the harness-working-memory spec). The loop answers each unanswered call of the task at its exit. Thus the continuation gets a valid transcript, and it removes no message from it.

#### Scenario: The summary continuation lets only the read tools run

- **WHEN** `generateStepSummary` runs
- **THEN** the continuation sends the system prompt and the tools of the step agent, and its cap is 12
- **AND** its mask lets only `read_file`, `grep`, and `read_tool_output` run
- **AND** each usage record of the continuation carries the `agentId` `step-summary-writer`

#### Scenario: The transcript reaches the request unchanged

- **GIVEN** a transcript whose last assistant message carried a tool call that the loop answered with the not-run result
- **WHEN** the summary continuation sends its request
- **THEN** the request holds each message of the transcript unchanged, and the summary request comes after them
