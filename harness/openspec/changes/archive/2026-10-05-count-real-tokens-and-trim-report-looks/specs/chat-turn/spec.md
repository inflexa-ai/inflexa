## MODIFIED Requirements

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
