# harness-agent-loop Specification

## Purpose
The agent loop of the harness runs one conversation of one agent with a model and its tools. It is durable inside a DBOS workflow. It has the same behavior in a chat turn, a workflow step, and a sub-agent.

## Requirements

### Requirement: A loop inside a workflow replays its completed calls

Inside a DBOS workflow, each model call and each tool call of the loop MUST be one checkpointed step. A recovery MUST return the recorded reply or the recorded tool result, and it MUST NOT call the model or run the tool again. A call that did not complete before a crash MUST run again from its start. Outside a workflow, each call MUST run directly, with no checkpoint.

#### Scenario: A recovered run does not call the model again

- **GIVEN** a workflow whose loop completed two model calls and one tool call before the process stopped
- **WHEN** the workflow recovers
- **THEN** the loop gets the two replies and the tool result from the checkpoints
- **AND** the provider gets no request and the tool does not run for those calls

#### Scenario: A chat turn runs its calls directly

- **WHEN** the loop runs outside a workflow
- **THEN** each model call and each tool call runs with no checkpoint

### Requirement: The identity of a model step holds no model id

The identity of a recorded model step MUST NOT depend on the model id. Thus a change of the configured model between two runs does not break the replay of a run that started before the change.

#### Scenario: The configured model changes during a run

- **GIVEN** a run that started with model A, and a configuration that now names model B
- **WHEN** the run recovers
- **THEN** the replay finds each recorded model step

### Requirement: The conversation is append-only

The loop MUST NOT edit, remove, or reorder a message that it sent. Each request of one conversation MUST send the same system prompt and the same declared tools in the same order. The tool choice and the reasoning effort MUST also stay the same. A conversation holds the requests of the run, of a salvage, of each follow-up request, and of each compaction exchange.

#### Scenario: Each request keeps the prefix of the request before it

- **GIVEN** a run with three model requests
- **WHEN** the requests are compared
- **THEN** each request starts with the system prompt, the tools, and the messages of the request before it, byte for byte

#### Scenario: A follow-up request keeps the declared tools

- **WHEN** a caller continues a finished conversation with a follow-up request whose policy lets one tool run
- **THEN** the request declares each tool of the agent, and the tool choice is unchanged

### Requirement: A policy refusal limits the calls that run

A caller MUST be able to limit the calls that run. A mask names the tools that can run for a request. A budget limits the calls of one tool in a run. A guard refuses repeated calls. A refused call MUST get a result that gives the reason, and its tool MUST NOT run. The declared tools MUST NOT change, and the run continues. A call in the same round counts against a budget.

#### Scenario: A masked call is refused

- **GIVEN** a request whose mask lets only `submit_plan` run
- **WHEN** the model calls `pubmed`
- **THEN** the call gets a refusal result with the reason, `pubmed` does not run, and the run continues

#### Scenario: A budget counts the calls of one round

- **GIVEN** a budget of 3 calls of `literature_reviewer`, and 2 earlier calls in the run
- **WHEN** one model reply calls `literature_reviewer` two times
- **THEN** the first call runs and the second call gets a refusal result

#### Scenario: A refusal reports an error outcome

- **WHEN** a policy refuses a call
- **THEN** its `tool-finished` event reports the outcome `error`

### Requirement: A tool failure becomes a result that the model can read

A tool can return an error value, throw, or receive input that fails its schema. Then the call MUST get an error result whose text gives the failure. The run continues, and the model can try again. A fatal error, for example the cancel of the workflow, MUST pass out of the loop and MUST NOT become a tool result.

#### Scenario: A thrown tool error is an error result

- **WHEN** a tool throws during its call
- **THEN** the call gets an error result with the message, and the next model request carries it

#### Scenario: A cancel passes through

- **WHEN** a cancel of the workflow occurs during a tool call
- **THEN** the loop throws the cancel error, and no tool result records it

### Requirement: A denial of the user ends the turn

When the user rejects the approval of a tool call, the call MUST get an `execution-denied` result that carries the feedback of the user. The other calls of the same reply complete. Then the loop MUST stop the turn, and it MUST NOT make a model request after the denial. An approval MUST NOT stop the turn.

#### Scenario: A rejected approval stops the turn

- **GIVEN** a reply with two tool calls, one of which asks for approval
- **WHEN** the user rejects the approval
- **THEN** both calls have results, the rejected call has a denied result, and no model request follows

### Requirement: A submit tool records a candidate and does not end the run

A submit tool MUST check one submission and give it back as accepted, or as refused with the issues. It MUST NOT end the run. The agent ends the run when it finishes its reply. The outcome of the run MUST be the last accepted submission. A refusal MUST state what is wrong clearly enough to repair it.

#### Scenario: The agent submits again after a refusal

- **WHEN** a submission is refused with its issues
- **THEN** the agent can submit again, and the run continues

#### Scenario: The last accepted submission wins

- **GIVEN** a run that submits two accepted candidates and then finishes
- **WHEN** the caller reads the outcome
- **THEN** the outcome is the second candidate

### Requirement: The outcome of a run comes from its recorded tool results

Each agent with an outcome MUST select it from the recorded inputs and results of its tool calls. One rule of precedence applies for each agent. The selection MUST NOT read a value that a tool body stored outside its result. Thus a replay selects the same outcome as the first run.

#### Scenario: A replay selects the same outcome

- **GIVEN** a workflow whose run recorded an accepted submission before the process stopped
- **WHEN** the workflow recovers, and the replay returns the recorded tool result without the tool body
- **THEN** the selection gives the same outcome as the first run

### Requirement: A run with no outcome gets one salvage request

When a run ends with no outcome, and the run was not aborted, the caller MUST send one more request in the same conversation. The request asks for the outcome, and only the terminal tools of the agent can run. When the salvage also gives no outcome, the caller takes its own path for a missing outcome.

#### Scenario: A run that ends on prose is salvaged

- **GIVEN** a planner that ends its run with text and no submission
- **WHEN** the run ends
- **THEN** one salvage request follows, and only the terminal tools of the planner can run in it

#### Scenario: An aborted run is not salvaged

- **WHEN** a run with no outcome ends because the caller aborted it
- **THEN** no salvage request follows

### Requirement: A follow-up request continues the conversation

A caller MUST be able to continue a finished conversation with one harness request. The request is a synthetic user message, thus it opens no turn in a stored thread. A policy limits which tools run, and the declared tools do not change. The caller gets only the new messages and the finish of the follow-up.

#### Scenario: The step summary continues the step conversation

- **WHEN** the workflow asks the step agent for its summary after the task
- **THEN** the request continues the conversation of the step agent, and it declares the same tools

### Requirement: Each unanswered tool call gets a not-run result at each exit

At each exit of the loop, each tool call of the run with no result MUST get an error result. The result states that the turn ended before the call ran. The loop MUST NOT run the call, and it MUST NOT remove a message. The exits include a stop, an abort, a denial, the step cap, a reply cut at the output limit, and a throw.

#### Scenario: A reply cut at the output limit leaves no unanswered call

- **GIVEN** a reply that the output limit cut, with a complete tool call that did not run
- **WHEN** the run ends
- **THEN** the call has a not-run result, and the next request of the conversation is valid

### Requirement: The run ends at its step cap

A run MUST end when it reaches its step cap, and its finish MUST report that it reached the cap. The loop MUST NOT send a wrap-up request at the cap.

#### Scenario: A capped run reports the cap

- **WHEN** a run reaches its step cap with tool calls in its last reply
- **THEN** the run ends, each call has a result, and the finish reports the cap

### Requirement: An abort keeps the partial reply

When the caller aborts a run, the run MUST end with the reason `aborted`. When the reply in flight has content, the partial reply MUST join the transcript with the interruption marker. An empty partial adds no message.

#### Scenario: An abort during streaming keeps the text

- **GIVEN** a chat turn whose reply streamed some text
- **WHEN** the user aborts the turn
- **THEN** the stored transcript holds the partial reply with the interruption marker

### Requirement: The model sees a tool picture only where the wire carries it

A tool result can carry an ordered list of pictures beside its data. When the provider carries a picture in a tool result, each picture MUST reach the model in the tool result. The pictures keep their order, after the text of the data. Otherwise, the loop MUST drop the pictures, keep the text, and log one warn with the count.

#### Scenario: A provider without pictures in tool results

- **GIVEN** an OpenAI-compatible provider that carries no picture in a tool result
- **WHEN** `examine_page` returns two pictures
- **THEN** the model gets the text only, and one warn gives the count 2

### Requirement: A long tool result is cut to an excerpt

When the text of a tool result is longer than 32,768 characters, the model MUST get an excerpt. The excerpt holds a line that states the cut, and the reference when the text is kept. Then it holds the first 4,096 characters, a marker with the count of the characters left out, and the last 8,192 characters. A denial keeps its text. The excerpt depends only on the text, the reference, and the choice to keep.

#### Scenario: A rerun gives the same excerpt

- **WHEN** a tool call with a long result runs again after a recovery
- **THEN** the excerpt is byte-identical to the excerpt of the first run

### Requirement: The text of a cut result is kept for read_tool_output

The run can have a tool output store, and the agent can declare `read_tool_output`. Then the loop MUST keep the text of a cut result under a reference before the result joins the transcript. The kept text holds up to 1,048,576 characters, else the first and the last 524,288. The reference MUST be the same on each rerun of the call, and the write is an upsert.

#### Scenario: The agent reads the kept text

- **WHEN** the agent calls `read_tool_output` with the reference of a cut result
- **THEN** it reads the kept text

### Requirement: A tool call record survives a replay

A tool result can carry a call record for process-local state. The loop MUST give each record to its tool after each round, in the order of the calls. This occurs on the first run and on each replay. The model MUST NOT read the record.

#### Scenario: The lineage of a replayed exec is folded

- **GIVEN** a step workflow that recovers after an `execute_command` call completed
- **WHEN** the replay returns the recorded result
- **THEN** the tool folds the record of the call, as on the first run

### Requirement: The loop compacts a conversation that passes its budget

With a compaction policy, the loop MUST compare the input tokens of the latest request with the budget before each request of the task. When the figure passes the budget, the loop MUST compact before it sends the request. Each request then sends the view from the latest summary marker. With no figure, the loop does not compact.

#### Scenario: A long turn compacts between two rounds

- **GIVEN** a chat turn whose latest request reported more input tokens than the budget
- **WHEN** the next request is due
- **THEN** the loop compacts first, and the request sends the new view

#### Scenario: No compaction in a follow-up request

- **WHEN** the latest figure passes the budget during a follow-up request or a compaction exchange
- **THEN** the loop does not start a compaction

### Requirement: A compaction is an exchange in the same conversation

A compaction MUST continue the current view with the request of the policy, under the same prefix. The exchange streams no text to the surface, and its usage counts under the agent id `<agent>-compaction`. When the last reply ends with `stop` and has text, that text is the summary. The loop appends a summary marker and the context records after it, and the next request sends that view.

#### Scenario: A summary starts a new view

- **WHEN** the exchange ends with a summary
- **THEN** the transcript holds the exchange, the summary marker, and the records, and the next request starts its view at the marker

### Requirement: A compaction with no summary changes nothing

The exchange can give no summary, or the provider can refuse its request for its content (HTTP 400 or 413). Then the loop MUST append no marker, and it MUST log the failure at `error` with the status. It compacts no more in the run. The run continues with the same view.

#### Scenario: A refused exchange leaves the view

- **WHEN** the provider refuses the compaction request with 413
- **THEN** the run continues with the same view, and one error record gives the status

### Requirement: The loop reports each compaction as a data part

The loop MUST emit a `data-compaction` part with the status `running` before the exchange. Then it MUST emit `done` or `failed` under the same id. Each part gives the trigger (`turn-start` or `mid-turn`) and the input tokens before. The terminal part also gives the duration.

#### Scenario: One compaction gives two parts

- **WHEN** a compaction ends with a summary
- **THEN** the surface gets a `running` part and a `done` part with the same id

### Requirement: A turn compacts before its input joins the conversation

When the latest figure before a turn passes the turn-start budget, the loop MUST compact before it appends the input of the turn. After a summary, the input joins with no context record. An abort during this compaction ends the run with `aborted`, and the input does not join.

#### Scenario: A turn starts after a compaction

- **GIVEN** a thread whose last request passed the turn-start budget
- **WHEN** the user sends a message
- **THEN** the loop compacts, then appends the message, then sends the first request

### Requirement: The loop gives each completed round to an optional sink

A caller outside a workflow MUST be able to give a round sink. The loop MUST give the sink each message that it appends, one time, in order: before each model request, at each exit, and before a throw. Before a throw, the unanswered calls get their not-run results first. A loop inside a workflow gives no sink.

#### Scenario: The store holds a round before the next request

- **WHEN** a round of tool results completes in a chat turn
- **THEN** the sink stores the round before the next model request is sent

### Requirement: Each model call is recorded when it completes

The loop MUST record the token usage of each model call when the call completes. It records counters and one usage record, whose key a replay gives again. A replay MUST NOT count a call a second time. The finish of a run carries the usage of its own calls, and the root of a turn also carries the total of the turn.

#### Scenario: A replay does not count again

- **WHEN** a workflow recovers and replays a recorded model step
- **THEN** the counters do not grow for that call, and the usage record has the same key as before

### Requirement: The loop caches its prompt prefix by default

The loop MUST cache the prompt prefix with a policy of 5 minutes unless the caller gives another policy or `off`. One policy MUST apply to each request of a run. Each request MUST mark the end of the system prompt and the last message that can carry a marker. The request itself carries no marker.

#### Scenario: Each request reads the prefix of the last one

- **WHEN** a run sends its second request
- **THEN** the second request carries the same system marker, and its message marker moves to its last message

### Requirement: Each request of a run carries one reasoning effort

The effort of a run MUST resolve in this order: the effort that the caller gives, the effort of the provider configuration, and then the default of the harness. The model can refuse that effort, and then the effort MUST go down to an effort that the model accepts. Each request of the run MUST carry the same effort.

#### Scenario: No effort from the caller

- **WHEN** a run starts with no reasoning effort
- **THEN** each request of the run carries the effort of the provider configuration

### Requirement: Each tool call is reported with its own outcome and duration

The loop MUST emit a `tool-started` event and a `tool-finished` event for each tool call. The `tool-finished` event carries the outcome (`ok`, `error`, or `denied`), the time of the call itself, and the detail that the tool describes. A loop that runs inside a tool call MUST set the id of that call on the source of each event.

#### Scenario: Two parallel calls report their own durations

- **WHEN** one reply calls two tools that run for 1 s and 5 s
- **THEN** the two `tool-finished` events report about 1,000 ms and about 5,000 ms

### Requirement: The loop writes one finish record for each run

The loop MUST write one record when a run ends. The record gives the count of the steps, the finish reason, the cap state, and the usage. A run that ended as intended logs at `info`. A run that reached the cap or ended on a denial logs at `warn`. A run that gave no result logs at `error`. Each record carries the agent id and the call path.

#### Scenario: A capped run logs a warn

- **WHEN** a run reaches its step cap
- **THEN** one `warn` record gives the reason and the step count

### Requirement: Each model failure is classified one time

A model call MUST retry a transient failure a bounded number of times. When the call fails, one classifier MUST name the class of the failure: a provider outage (retries spent), a billing refusal, a missing or invalid credential, or another failure. Each class keeps the outcome that it has before this change.

#### Scenario: A provider outage is named

- **WHEN** a model call fails with HTTP 503 on each retry
- **THEN** the failure has the class of a provider outage, and the run takes the same path as before this change

### Requirement: A sub-agent runs under a child session

A tool that runs a sub-agent MUST run it under a child session. The agent id of that session is the sub-agent, and its call path extends the call path of the caller. The session of the caller does not change. The messages of the sub-agent are not stored with the turn.

#### Scenario: The events of a sub-agent carry its call path

- **WHEN** the planner runs inside `generate_plan`
- **THEN** each event of the planner carries the call path of the conversation agent, then the planner

### Requirement: The loop reports each retry of a model request

The model binding MUST accept `onRetry`. The retry envelope of the provider MUST call it before the wait of each retry of a request, with the id of the request, the number of the retry, the count of retries, the wait, and the HTTP error status of the failed attempt when it has one. The loop MUST then emit the part `data-model-retry` with the same id, the number, the count, the time of the next attempt, and the status. The part MUST be transient: the stored transcript does not hold it. A failed write of the part MUST NOT change the request.

#### Scenario: A request that the envelope retries

- **GIVEN** a provider with one retry, and a model whose first attempt fails with `503`
- **WHEN** the loop sends the request
- **THEN** the loop emits one `data-model-retry` part with the retry 1 of 1 and the status `503`, and the second attempt gives the reply
