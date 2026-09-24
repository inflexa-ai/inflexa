## MODIFIED Requirements

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

### Requirement: Sandbox standards teach literature grounding during execution

`sandbox-standards` MUST tell sandbox agents to ground their findings in the research literature as they work. The standards direct an agent to search PubMed (`search_pubmed`) and to read abstracts (`get_article_details`). The agent assesses the novelty of each finding during the primary execution turns. The standards MUST NOT defer this work to a final step. The post-step summary continuation MUST NOT search the literature. Its mask lets only `read_file`, `grep`, and `read_tool_output` run, and it grounds claims in persisted files through `read_file`.

#### Scenario: Agent searches literature while working

- **WHEN** a sandbox agent finds a significant result during its primary analysis turns
- **THEN** the standards direct it to search PubMed for related prior work at that point, not in the summary continuation

#### Scenario: Summary continuation does not search literature

- **GIVEN** a step agent that declares `search_pubmed`, and a summary continuation whose model calls it
- **WHEN** the loop dispatches the call
- **THEN** the call gets the error result of the mask, and no search runs
