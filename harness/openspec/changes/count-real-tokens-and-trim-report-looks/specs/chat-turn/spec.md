## MODIFIED Requirements

### Requirement: The root loop of a chat turn compacts the conversation

`runChatTurn` MUST give the root loop a compaction policy (see the harness-agent-loop capability). The budgets MUST come from the thread type:

- A `conversation` thread gets a turn-start budget of 150,000 tokens, and a budget of 200,000 tokens during a turn.
- A `report` thread gets no turn-start budget, and a budget of 250,000 tokens during a turn.

The budgets apply to the measure of the view, thus they count the tokens that the provider reports. A host MUST be able to pass the optional parameter `conversationBudget`. It replaces the budget during a turn on each thread type. On a `conversation` thread, it also replaces the turn-start budget when it is lower than 150,000.

The policy of the turn MUST hold these values:

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

A mid-turn compaction puts the user message of the turn before the marker. Thus the summary carries that request. A turn-start compaction keeps the user message of the turn after the marker. Thus the next request carries that message in its exact words.

After a marker, the turn MUST add a record of each kind that the new view holds no copy of. It MUST also add a record of each kind whose hash differs from the latest copy in the new view. After a summary marker, the new view holds no copy, because a kept turn loses its context records. Thus each kind comes back: the analysis context when it exists, the run activity, and the working memory on a `conversation` thread.

The sub-agent loops of the turn MUST get no policy.

#### Scenario: A host budget wins

- **GIVEN** a host that passes `conversationBudget: 2000`, and a `conversation` thread with an earlier turn, whose view exceeds 2,000 tokens
- **WHEN** a turn runs
- **THEN** the root loop does a turn-start compaction before its first task request
- **AND** the task request holds the summary marker, the user message of the turn, and then the context records

#### Scenario: A small thread does not compact under the default budget

- **GIVEN** a host that passes no budget, and a thread whose view is 10,000 tokens
- **WHEN** a turn runs
- **THEN** no exchange runs, and the thread holds no marker

#### Scenario: A conversation thread compacts at the turn start by the reported tokens

- **GIVEN** a host that passes no budget, and a `conversation` thread whose last reply carries 160,000 input tokens of its request
- **WHEN** a turn runs
- **THEN** a turn-start compaction runs before the first task request
- **AND** its summary marker carries 1 kept turn and the trigger `turn-start`

#### Scenario: A report thread runs no turn-start compaction

- **GIVEN** a host that passes no budget, and a `report` thread whose last reply carries 240,000 input tokens of its request
- **WHEN** a turn runs
- **THEN** no exchange runs

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
- **WHEN** the planner loop sends a request over the budget of the turn
- **THEN** the planner loop runs no exchange
