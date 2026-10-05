# chat-turn Specification

## Purpose
The harness runs the whole chat turn for each host. A turn stores its opening and its context records after the user message, stores each round when it completes, and closes with one outcome.

## Requirements

### Requirement: The harness runs the whole chat turn

The harness MUST give one app function, `runChatTurn(deps, params)`, that runs one chat turn from the user input to the outcome. The function MUST do these steps in this order:

1. Prepare the turn with `prepareChatTurn`.
2. Resolve the agent with `agents.forThread` over the thread type that the preparation gives.
3. Store the opening of the turn.
4. Run `runAgent` with a round sink that stores each round.
5. Close the turn with its outcome.

The deps give the pool, the agent resolver, the logger, and the provenance seam. The host gives only these transport values:

- the emit sink of its surface
- the abort signal of the turn
- a factory that makes the provider of the turn over an emit sink
- the usage recorder
- the approval binding, when the surface can ask the user
- the author of the user message, and the start time of the turn

A host can also pass a cache policy for the root loop (see "The root loop of a chat turn caches its prefix for 1 hour").

A host MUST NOT run the steps itself. Thus each host stores the same rows, and a change of the turn reaches each host with no change of the host.

The function MUST give one of these results:

- `prepare_failed`, with the cause, when the preparation throws
- `not_found`, when a different analysis owns the thread
- `agent_unresolved`, with the thread type, when the resolver refuses the type
- `ran`, with the outcome, `opened`, the store error when there is one, the duration, the turn usage, and the final text

A turn that ends before the run writes no row and no turn record.

#### Scenario: A host runs a turn with one call

- **WHEN** a host calls `runChatTurn` with its emit sink, its signal, its provider factory, and its usage recorder
- **THEN** the thread holds the opening, each round, and a closed turn record, and the host wrote no row itself

#### Scenario: A refused thread type writes nothing

- **GIVEN** a thread whose type has no registered agent
- **WHEN** `runChatTurn` runs a turn on it
- **THEN** the result is `agent_unresolved` with the thread type, and the turn wrote no row and no turn record

#### Scenario: A thread of a different analysis is not found

- **GIVEN** a thread that a different analysis owns
- **WHEN** `runChatTurn` runs a turn on it
- **THEN** the result is `not_found`, and the thread did not change

### Requirement: A turn stores its opening before the first model request

Before the first model request of a turn, the turn MUST write its opening in one transaction. The opening holds the user message and each context record that the loop sent with it. The same transaction MUST add the turn record with the status `open`. When that write fails, the next write of the turn stores the opening first.

The turn MUST NOT write the opening before the run. It MUST give the loop the user message and its context records as `turnInput` (see the harness-agent-loop capability). The round sink gets them as one round, directly before the first request. Thus the stored thread holds each message in the order that the harness sent it.

A turn-start compaction comes before the opening. After a turn-start summary, the opening holds the user message and no context record, because the records after the marker restate the context. When the exchange gives no summary, the opening keeps its context records. A mid-turn compaction before the first request comes directly after the opening.

A turn that ends before the loop sent its user message MUST store no user message and no turn record. An abort or a throw during the turn-start compaction ends a turn at that point. The result then carries `opened: false`.

The row of the user message carries the author of the turn and the display projection of the user message. A context record has no display projection.

#### Scenario: The opening lands before the model answers

- **GIVEN** a provider that reads the stored rows of the thread at its first call
- **WHEN** a turn runs
- **THEN** the rows end with the user message and the context records of the turn, and the turn record is `open`

#### Scenario: The opening carries the author

- **GIVEN** a turn with an author
- **WHEN** the thread is read back
- **THEN** the row of the user message carries the author, and no context record carries it

#### Scenario: A turn-start compaction comes before the opening

- **GIVEN** a `conversation` thread whose last reply carries input tokens over the turn-start budget, and an exchange that gives a summary
- **WHEN** a turn runs
- **THEN** the thread holds the exchange, the summary marker and its records, and then the user message, in this order
- **AND** the turn record starts at the user message

#### Scenario: A mid-turn compaction request comes after the opening

- **GIVEN** a `report` thread whose last reply carries input tokens over the budget of the turn
- **WHEN** the turn sends its first model request
- **THEN** that request ends with the opening and then the compaction request, and the store holds the opening already

#### Scenario: A turn that ends in the turn-start compaction stores no opening

- **GIVEN** a turn whose signal aborts during the turn-start exchange
- **WHEN** the turn ends
- **THEN** the thread holds the exchange and no user message of the turn
- **AND** no turn record exists for the turn, and the result carries `opened: false`

### Requirement: The per-turn context is a record after the user message

The preparation MUST put the per-turn context after the user message of the turn, as `user` messages. Each message is a context record of one kind:

- `analysis-context`: the analysis context of the host, when it is not null and not empty.
- `run-activity`: the Run Activity render.
- `working-memory`: the working-memory render. A `report` thread gets no record of this kind.

The order of the records MUST be: analysis context, run activity, working memory. The text of a record MUST start with the tag of its kind in square brackets, on its own line. An empty working memory MUST give a record that states that the memory is empty.

A record MUST NOT be a `system` message. The agent writes the working memory from data that it read, and the harness does not trust that data. Also, Claude Sonnet 5 refuses a `system` message inside the conversation.

The preparation MUST add a record of a kind only in two conditions:

- The history window holds no record of that kind.
- The hash of the new text differs from the hash of the latest record of that kind in the window.

Thus a turn with no change adds no record, and the prefix of the next request stays byte-identical to the stored rows.

A record carries its kind and its hash in the harness namespace, and it is a synthetic message (see the ai-sdk-message-storage capability). Thus it opens no turn, and the display skips it.

#### Scenario: A first turn gets each record after the user message

- **GIVEN** a `conversation` thread with no stored record, and a host with no analysis context
- **WHEN** a turn is prepared
- **THEN** the messages end with the user message, then the run-activity record, then the working-memory record

#### Scenario: A turn with no change adds no record

- **GIVEN** a thread whose last turn stored each kind of record, and no later change of the run activity or the working memory
- **WHEN** the next turn is prepared
- **THEN** the messages end with the user message, and each earlier message is byte-identical to its stored row

#### Scenario: A changed memory adds one record

- **GIVEN** a thread whose last turn stored each kind of record, and a working memory that changed after that turn
- **WHEN** the next turn is prepared
- **THEN** the messages end with the user message and one working-memory record with the new render

#### Scenario: An evicted record is added again

- **GIVEN** a thread whose history window no longer holds a working-memory record
- **WHEN** a turn is prepared
- **THEN** the turn adds a working-memory record, although the memory did not change

#### Scenario: A report turn gets no working-memory record

- **WHEN** a turn is prepared on a `report` thread
- **THEN** the turn adds no working-memory record

#### Scenario: An empty memory replaces an old copy

- **GIVEN** a thread whose window holds a working-memory record with entries, and a working memory that is now empty
- **WHEN** the next turn is prepared
- **THEN** the turn adds a working-memory record that states that the memory is empty

### Requirement: The turn stores each round when it completes

The turn MUST give `runAgent` a round sink. For each round, the sink MUST store the messages of the round and the display projection of the round in one transaction. The display projection holds the parts that the live events of the round carried. The two rounds of a compaction obey their own rule (see "The chat turn stores each compaction round").

A store fault MUST NOT stop the turn. The turn keeps the rows of the failed write. The next write of the turn stores them first, in its transaction and in order. Thus a row never lands before an earlier row of its turn.

The result MUST carry `opened`, which is true when the opening landed. It MUST carry the store error when rows of the turn did not land by the close.

A host MUST NOT append a record of its own to a thread while a turn of that thread is `open`. Such a record would land between two rounds, and the stored order would then differ from the sent order.

#### Scenario: A long turn keeps its rounds after a failure

- **GIVEN** a turn whose provider answers two rounds with tool calls and then fails with HTTP 401
- **WHEN** the turn ends
- **THEN** the thread holds the opening, the two rounds, and the failure note, in this order

#### Scenario: A store fault is written again with the next round

- **GIVEN** a turn whose store refuses the write of its first round one time
- **WHEN** the second round completes
- **THEN** one transaction stores the first round and then the second round, and the result carries no store error

#### Scenario: An opening that never lands is reported

- **GIVEN** a store that refuses each write of the turn
- **WHEN** the turn ends
- **THEN** the result carries `opened: false` and the store error

#### Scenario: A compaction stores two rounds

- **GIVEN** a turn whose root loop compacts between two rounds
- **WHEN** the turn ends
- **THEN** the thread holds the first round, the exchange, the marker with its records, and the second round, in this order

### Requirement: A turn closes with one outcome

A turn MUST have one status: `open` while it runs, then `done`, `aborted`, or `failed`. The close MUST set the status one time, in the transaction that stores the last rows of the turn.

The turn MUST select the status from the run:

- A run that returns with the finish reason `aborted` is `aborted`.
- A run that returns with a different finish reason is `done`. This includes the finish reasons `content-filter`, `max_iterations`, and `denied`.
- A run that throws an `AbortError` while the signal of the turn is aborted is `aborted`.
- A run that throws a different error is `failed`.

The close MUST store the usage rollup of the turn and its duration on the turn record. A rollup that reports no quantity is stored as absent. The duration counts from the start time that the host gives, or from the call when the host gives none.

A turn that no process closes, for example after a crash, stays `open`. The harness MUST NOT guess its outcome. When the write of the close fails, the record also stays `open`, and the result carries the store error.

#### Scenario: A clean turn closes as done

- **GIVEN** a turn whose model answers in text after one tool round
- **WHEN** the turn ends
- **THEN** the turn record is `done`, with the rollup of the turn and its duration

#### Scenario: A filtered reply closes as done

- **GIVEN** a turn whose model stops with the finish reason `content-filter`
- **WHEN** the turn ends
- **THEN** the turn record is `done`, and the outcome carries the finish with that reason

#### Scenario: An interrupt closes as aborted

- **GIVEN** a turn that the user aborts before the model gives output
- **WHEN** the turn ends
- **THEN** the thread holds the opening, and the turn record is `aborted`

#### Scenario: A thrown abort closes as aborted

- **GIVEN** a turn whose run throws an `AbortError` after the user aborts the signal
- **WHEN** the turn ends
- **THEN** the turn record is `aborted`, and the result carries no failure

### Requirement: A failed turn tells the model what occurred

When a turn fails, the close MUST append a failure note after the stored rounds. The note is a synthetic record message, thus it opens no turn, and the display shows it as a `system` message. The note MUST give the reason of the failure. It MUST also state that the rounds before it ran.

The reason MUST be a short text that the harness makes from the class of the error:

- A `suspend` error gives the suspend reason of the host, for example `payment_required`.
- An `auth` provider error gives a fixed text that the model endpoint refused the credential.
- A different provider error gives a fixed text that the model request failed.
- A different error gives a fixed text that the turn stopped on an internal error.

The reason MUST NOT hold the message of the error. An error message can hold a secret or a path of the host, and each later turn sends the note to the model provider.

Before the turn stores the last round, the loop answers each unanswered tool call of that round with the not-run result (see the harness-agent-loop capability). Thus the next turn continues from the stored rounds.

The result MUST carry the error as `cause`. Thus a host reads a suspension with `suspensionOfFailure`.

#### Scenario: A 401 keeps the work and adds a note

- **GIVEN** a turn whose third model request fails with an `auth` provider error
- **WHEN** the turn ends
- **THEN** the thread holds the opening, two rounds, and a note with the credential reason, and the turn record is `failed` with the same reason

#### Scenario: A suspend error gives the reason of the host

- **GIVEN** a turn whose model request fails with a `suspend` error with the reason `payment_required`
- **WHEN** the turn ends
- **THEN** the note and the turn record give the reason `payment_required`, and the status of the analysis does not change

#### Scenario: The note holds no error text

- **GIVEN** a turn that fails with an error whose message holds a URL and a key
- **WHEN** the turn ends
- **THEN** the note and the turn record hold the fixed reason, and no part of the error message

#### Scenario: The next turn continues from the stored rounds

- **GIVEN** a thread whose last turn failed after two rounds
- **WHEN** the next turn is prepared
- **THEN** its messages start with each stored row of the failed turn, byte-identical, the note included

### Requirement: The root loop of a chat turn caches its prefix for 1 hour

`runChatTurn` MUST run the root conversation loop with the cache policy `{ ttl: "1h" }`, through `RunAgentOptions.promptCache`. A host MUST be able to pass a different policy with the optional parameter `promptCache`, for example `{ ttl: "5m" }` or `"off"`.

A person can reply 5 to 60 minutes after the last reply. A 1-hour entry stays in the cache for that gap, and a 5-minute entry does not. A 1-hour write costs 2 times the base input price, and a 5-minute write costs 1.25 times.

The policy rides on the run, not on the provider configuration. Thus it reaches only the root loop, and each loop takes its policy from its own run options. Each other loop MUST keep `DEFAULT_PROMPT_CACHE`, which is 5 minutes:

- the planner
- the analogy report
- the literature reviewer
- each workflow loop

The requests of such a loop start less than 5 minutes apart, thus a 1-hour write would cost more than it saves.

#### Scenario: The root loop writes 1-hour entries

- **GIVEN** a turn whose host passes no cache policy
- **WHEN** the root loop sends a request
- **THEN** the system prompt and the last message of the request carry the 1-hour cache directive

#### Scenario: A host policy wins

- **GIVEN** a host that passes `promptCache: { ttl: "5m" }` to the turn
- **WHEN** the root loop sends a request
- **THEN** the request carries the 5-minute cache directive

#### Scenario: A sub-agent loop keeps 5 minutes

- **GIVEN** a turn whose tool runs the planner
- **WHEN** the planner loop sends a request
- **THEN** the request carries the 5-minute cache directive

### Requirement: The root loop of a chat turn compacts the conversation

`runChatTurn` MUST give the root loop a compaction policy when the agent of the thread declares compaction rules, `AgentDefinition.compaction` (see the harness-agent-loop capability). The budgets MUST come from those rules. An agent with no rules gets no policy, and its conversation never compacts. The chat turn MUST NOT take a budget from the host.

The agents of a chat thread declare these rules:

- The conversation agent has a turn-start budget of 150,000 tokens, and a budget of 200,000 tokens during a turn.
- The report session agent has no turn-start budget, and a budget of 250,000 tokens during a turn. A report session is one long turn that holds page captures.

The budgets apply to the input tokens that the provider reports for a request.

The chat turn MUST add the mechanism of the policy to the rules:

- The provider of the exchange comes from the provider factory of the host, over an emit sink that drops each text delta.
- The turn selects the variant of the exchange from the declared tools of the agent.
- On a `conversation` thread, the agent declares `update_working_memory`. The mask lets only that tool run, and the request asks for the memory edits first.
- A `report` thread reads a frozen copy of working memory, and its agent declares no `update_working_memory`. Its mask is `"none"`, and its request has only the summary step.
- The request of a `conversation` thread asks for a summary in plain text. The summary leaves out each fact that a memory edit accepted, and it carries each fact that the memory refused. The request gives the number of replies that the memory edits can use.
- The request of a `report` thread asks for a summary in plain text that leaves out what working memory holds.
- A `report` thread keeps its first turn, the seed, in front of each view.

The summary gives these facts:

- the last request of the person in its exact words
- on a `report` thread, the goals and each change that the person made to the brief
- the decisions, with their reasons
- the approaches that failed or that the person ruled out, with the reasons
- the open questions
- the file paths, the run ids, and the other exact values that the work uses
- the state of the work in progress

A mid-turn compaction puts the user message of the turn before the marker. Thus the summary carries that request. A turn-start compaction comes before the user message of the turn. Thus the next request carries that message in its exact words, after the summary.

After a marker, the turn MUST add a record of each kind that the new view holds no copy of. It MUST also add a record of each kind whose hash differs from the latest copy in the new view. After a summary marker, the new view holds no copy. Thus each kind comes back: the analysis context when it exists, the run activity, and the working memory on a `conversation` thread.

The sub-agent loops of the turn MUST get no policy.

#### Scenario: A small thread does not compact

- **GIVEN** a thread whose last reply carries 10,000 input tokens of its request
- **WHEN** a turn runs
- **THEN** no exchange runs, and the thread holds no marker

#### Scenario: A conversation thread compacts at the turn start by the reported tokens

- **GIVEN** a `conversation` thread whose last reply carries 160,000 input tokens of its request
- **WHEN** a turn runs
- **THEN** a turn-start compaction runs before the user message joins the conversation
- **AND** its summary marker carries the trigger `turn-start`
- **AND** the first task request holds the summary marker, the context records, and then the user message

#### Scenario: A report thread runs no turn-start compaction

- **GIVEN** a `report` thread whose last reply carries 240,000 input tokens of its request
- **WHEN** a turn runs
- **THEN** no exchange runs

#### Scenario: An agent with no rules does not compact

- **GIVEN** a thread whose agent declares no compaction rules, and whose last reply carries 500,000 input tokens of its request
- **WHEN** a turn runs
- **THEN** the root loop gets no policy, and no exchange runs

#### Scenario: The summary does not reach the surface

- **GIVEN** a turn whose root loop compacts
- **WHEN** the exchange replies with a summary
- **THEN** the emit sink of the host gets no text delta of the summary

#### Scenario: The working memory follows the summary

- **GIVEN** a `conversation` thread whose exchange adds a constraint to working memory
- **WHEN** the root loop sends the request after the marker
- **THEN** the request holds the summary marker and, after it, the context records, and the working-memory record holds the constraint

#### Scenario: A report turn keeps the seed and adds no working-memory record

- **GIVEN** a `report` thread whose root loop compacts
- **WHEN** the root loop sends the request after the marker
- **THEN** the request starts with the seed and then the summary marker, and no working-memory record follows the marker

#### Scenario: A report exchange runs no tool

- **GIVEN** a `report` thread whose root loop compacts
- **WHEN** the exchange calls a tool of the report agent
- **THEN** the tool does not run, and the call gets the error result of the mask `"none"`
- **AND** the request of the exchange has no memory step

#### Scenario: A sub-agent loop does not compact

- **GIVEN** a turn whose tool runs the planner
- **WHEN** a request of the planner loop reports input tokens over the budget of the turn
- **THEN** the planner loop runs no exchange

### Requirement: The chat turn stores each compaction round

The round sink of the turn MUST store the two rounds of a compaction, each in one transaction: the exchange, and then the marker with its records. The exchange MUST carry no display projection. The marker round MUST carry the divider of the marker on the row of the marker (see the harness-thread-history capability).

The turn record, the paged read of whole turns, and the tail retract read the user message as the first row of a turn. Thus the sink MUST write the rounds of a turn-start compaction with `appendTurn`, before the opening, with no turn record. The turn opens at the user message, after those rounds.

The display recorder MUST NOT take the text of an exchange message as the text of a round. Thus the summary never shows as a reply of the assistant, live or after a reload.

After a marker round, the recorder MUST give the later rounds of the turn a new assistant id. The divider separates the rounds before it from the rounds after it. Thus the replay gives two assistant messages, and the two must not share an id.

The rows of a mid-turn compaction belong to the turn that made them. A tail retract removes them with that turn, and the view then goes back to the previous marker. The rows of a turn-start compaction come before the user message of the turn. Thus a tail retract of that turn keeps them, and a turn-start summary stays in the view. The host makes no new call for a compaction.

#### Scenario: A reload shows the divider between two rounds

- **GIVEN** a turn that compacts between its first and its second round
- **WHEN** `loadAll` reads the thread and the transcript replay runs
- **THEN** the replay gives the user message, an assistant message, the divider, and an assistant message
- **AND** the two assistant messages carry two different ids

#### Scenario: A reload shows a turn-start divider before the user message

- **GIVEN** a turn that starts with a turn-start compaction with a summary
- **WHEN** `loadAll` reads the thread and the transcript replay runs
- **THEN** the replay gives the divider, then the user message of the turn, and then its assistant message

#### Scenario: The summary is not a reply

- **GIVEN** a turn that compacts with a summary
- **WHEN** the transcript replay runs
- **THEN** no assistant message of the replay holds the text of the summary

#### Scenario: The next turn starts from the summary

- **GIVEN** a `conversation` thread whose last turn compacted
- **WHEN** the next turn is prepared
- **THEN** its history starts with the summary marker and its records, and then the later rounds

#### Scenario: A retract removes the mid-turn compaction of the last turn

- **GIVEN** a thread whose last turn did a mid-turn compaction after an earlier summary marker
- **WHEN** `retractLastTurn` removes the last turn
- **THEN** no row of the exchange or of the new marker remains, and the next turn starts from the earlier summary marker

#### Scenario: A retract keeps the turn-start compaction of the last turn

- **GIVEN** a thread whose last turn started with a turn-start compaction with a summary
- **WHEN** `retractLastTurn` removes the last turn
- **THEN** the rows of the exchange and of the marker remain, and the next turn starts from that summary marker

### Requirement: A chat turn opens before it runs

The harness MUST give `openChatTurn(deps, { analysisId, threadId, userInput })`. It MUST prepare the turn and resolve the agent of the thread type. It MUST give one of these results:

- `prepare_failed`, `not_found`, or `agent_unresolved`, as `runChatTurn` gives them
- `ready`, with the resolved `agent` and a `run` function that takes the transport values of the turn

A refusal MUST come back before the turn writes a row or a turn record. Thus a host can answer a refusal before it starts a stream. `runChatTurn` MUST be `openChatTurn` and then `run`.

#### Scenario: A thread of a different analysis is refused at the open

- **GIVEN** a thread that a different analysis owns
- **WHEN** a host calls `openChatTurn` on it
- **THEN** the result is `not_found`, and the thread holds no row and no turn record of the turn

### Requirement: The harness sets the provenance of the root agent of a chat turn

The host MUST give the session of a turn with no provenance. The harness MUST set the provenance of the session to the id of the resolved agent, with a call path that holds only that id. Thus the billing headers, the usage records, and the provenance events of the turn carry the id of the agent that ran it.

#### Scenario: A report thread runs under the id of the report agent

- **GIVEN** a thread of the type `report`, and a resolver that gives the report agent for that type
- **WHEN** a host opens the turn and runs it
- **THEN** the open turn gives the report agent, and each usage record of the run carries the id of that agent

### Requirement: The display of the user message holds the sanitized text

The display projection of the user message MUST hold the same sanitized text as the model message. Thus the stored display never holds a secret that the redaction removed from the model message.

#### Scenario: A pasted key does not reach the stored display

- **GIVEN** a user input that holds an API key
- **WHEN** a turn stores its opening
- **THEN** the stored display of the user message holds the redacted text, and not the key
