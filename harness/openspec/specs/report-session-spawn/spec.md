# report-session-spawn Specification

## Purpose

Define the operation that makes a report session: a child thread of an analysis conversation. The thread model holds the type, the parent link, and the anchor columns. This capability is the producer of the `report` thread type. It composes the reads and the write that the thread store and the thread history give, and it owns no table.

The anchor records the point in the parent transcript at the spawn. The read takes no lock, because the conversation moves regardless. A reader treats an anchor past the parent's end as a normal state.

The spawn refuses what can never make a good session: an absent or archived parent, a parent that is not a conversation, and an empty transcript. The tree under an analysis stays flat. A conversation spawns report sessions, and a report session spawns nothing.

## Requirements

### Requirement: The spawn makes a report child thread
The spawn operation MUST make a child thread with the type `report`, the parent thread id, and the anchor. It MUST mint the child thread id, and it MUST give back the full thread row. The child belongs to the analysis of the parent.

#### Scenario: A report session spawns from a conversation
- **WHEN** the caller spawns from a live conversation thread that holds turns
- **THEN** the child holds the type `report`, the parent thread id, and the analysis id of the parent

#### Scenario: The child appears under its parent
- **WHEN** the caller lists the threads narrowed by the parent thread id
- **THEN** the listing holds the spawned child

### Requirement: The anchor is the latest seq at the spawn
The spawn MUST set the anchor to the latest `messages.seq` value of the parent at the moment of the spawn. The read takes no lock. A later append to the parent MUST NOT change the anchor of the child.

#### Scenario: The anchor equals the transcript end
- **WHEN** the caller spawns from a parent whose latest seq is 14
- **THEN** the child holds the anchor 14

#### Scenario: The parent moves on, and the anchor stays
- **WHEN** the parent appends a turn after the spawn
- **THEN** the anchor of the child keeps its value from the spawn

### Requirement: The spawn refuses an absent or archived parent
The spawn MUST refuse a parent id that resolves to no live thread. The refusal is typed data with the reason `parent_not_found`. An archived parent refuses the same way, because a spawn into hidden state is not permitted.

#### Scenario: An unknown parent refuses
- **WHEN** the caller spawns with a parent id that no thread holds
- **THEN** the spawn refuses with `parent_not_found`, and no thread is written

#### Scenario: An archived parent refuses
- **WHEN** the caller spawns from a thread that is archived
- **THEN** the spawn refuses with `parent_not_found`, and no thread is written

### Requirement: The spawn refuses a parent that is not a conversation
The spawn MUST refuse a parent whose type is not `conversation`. The refusal is typed data with the reason `parent_not_a_conversation`. Thus a report session cannot spawn another report session, and the thread tree under an analysis stays flat.

#### Scenario: A report parent refuses
- **WHEN** the caller spawns with the id of a report thread as the parent
- **THEN** the spawn refuses with `parent_not_a_conversation`, and no thread is written

### Requirement: The spawn refuses an empty parent transcript
The spawn MUST refuse a parent that holds no messages. The refusal is typed data with the reason `empty_parent_transcript`. A report on an empty transcript reports nothing, thus the refusal is the correct answer.

#### Scenario: An empty conversation refuses
- **WHEN** the caller spawns from a live thread with no messages
- **THEN** the spawn refuses with `empty_parent_transcript`, and no thread is written

### Requirement: The title of the child
The spawn MUST set the child title to `{parent title} — Report N`. N is the count of the existing report children of the parent, plus one. When the parent holds no title, the title MUST be `Report N` alone.

#### Scenario: The first report session
- **WHEN** the caller spawns the first report child of a parent with the title "RNA-seq QC"
- **THEN** the child title is "RNA-seq QC — Report 1"

#### Scenario: The second report session
- **WHEN** the caller spawns again from the same parent
- **THEN** the child title is "RNA-seq QC — Report 2"

#### Scenario: A parent without a title
- **WHEN** the caller spawns from a parent whose title is null
- **THEN** the child title is "Report 1"

### Requirement: The children listing
The operation MUST give the report sessions of one analysis. It narrows the thread listing to the type `report`, and it adds no other predicate. Thus the answer and the thread listing cannot disagree.

#### Scenario: Only the report sessions return
- **WHEN** an analysis holds two conversations and one report session, and the caller lists the report sessions
- **THEN** the listing holds the one report session

### Requirement: One eyes rule serves the spawn and the tool that runs it
The harness MUST hold one rule that decides whether a composition gives a route to a look. The spawn MUST read that rule, and the start tool MUST read the same rule. The tool MUST NOT hold a second rule of its own. Thus a route that opens the gate of the spawn opens the gate of the tool.

The tool reads the rule for one reason. Its advice costs two database reads, and a closed gate must skip them. The gate of the tool is an optimization, and the refusal itself stays with the spawn.

The tool MUST read the rule over the values that it gives to its own spawn. Thus the gate of the tool answers for the very operation that would refuse.

The obligation binds the composition that the harness assembles. An embedder that builds the tool by hand owns the consistency of the values that it binds.

The assembly MUST resolve the eyes one time. That one answer MUST reach the agent that looks at a page, and it MUST reach the tool that starts the session.

#### Scenario: A bound seam opens the gate of the tool
- **WHEN** the composition binds the eyes seam, it names no browser endpoint, and the agent calls the tool
- **THEN** the tool starts the session, and the thread listing holds the child

#### Scenario: A composition with no route refuses at the tool
- **WHEN** the composition binds no eyes seam, no capture seam, and no browser endpoint
- **THEN** the tool gives the `no_browser` arm, and it runs no advice read

#### Scenario: One resolved answer serves both consumers
- **WHEN** the harness builds the agent that looks at a page and the tool that starts a session over one resolved answer
- **THEN** the agent looks through the browser of that answer, and the tool starts a session with no configured endpoint

### Requirement: The spawn refuses a composition with no eyes
The spawn MUST refuse when the composition gives no eyes. No eyes means: no capture seam, no eyes seam, and no configured browser endpoint. The refusal is typed data with the reason `no_browser`, and no thread is written. A report session records a version only after a look at the rendered page. Thus a session under a composition with no eyes is a dead end, and the refusal at the spawn is the honest answer.

An eyes seam alone MUST satisfy the gate. A capture seam alone MUST satisfy the gate. A configured browser endpoint alone MUST satisfy the gate.

#### Scenario: A composition with no eyes refuses

- **WHEN** the caller spawns under a composition with no capture seam, no eyes seam, and no browser endpoint
- **THEN** the spawn refuses with `no_browser`, and no thread is written

#### Scenario: An eyes seam satisfies the gate

- **WHEN** the composition binds an eyes seam and no browser endpoint
- **THEN** the spawn does not refuse for the eyes

### Requirement: The conversation agent starts a report session through one tool

The conversation agent MUST offer the tool `start_report_session`. The tool MUST run the spawn operation with the thread id of the call scope as the parent. The tool MUST NOT accept a parent id as input.

The input MUST carry the intent brief: `objective`, `audience`, `angle`, optional `exclusions`, and optional `openQuestions`. The brief holds intent only, and no field names a path, a dataset, or a format. Each field MUST carry a length bound in the schema, because the brief lands in a durable message row. The input MUST also carry the optional override of the thin-delta advice.

A call whose scope carries no thread id MUST refuse as typed data in the ok channel. A spawn refusal MUST pass through as typed data, and the arm names the reason. The `no_browser` arm MUST carry the detail of the spawn, thus the agent can tell the user that the deployment has no eyes. A store fault MUST return as typed data with a short detail. A success MUST return the thread id and the title of the child. The tool MUST NOT throw for a degraded condition.

#### Scenario: The tool starts a session

- **WHEN** the agent calls `start_report_session` with a brief, on a live conversation that holds turns
- **THEN** the result carries the thread id and the title of the child, and the thread listing holds the child

#### Scenario: A scope without a thread id refuses

- **WHEN** the tool runs with a scope that carries no thread id
- **THEN** the result is typed data that names the missing thread id, and no thread is written

#### Scenario: A composition without eyes refuses

- **WHEN** the composition gives no browser and no capture seam, and the agent calls the tool
- **THEN** the result carries the `no_browser` arm with its detail, and no thread is written

#### Scenario: A spawn refusal passes through

- **WHEN** the agent calls the tool on a conversation that holds no messages
- **THEN** the result carries the `empty_parent_transcript` arm, and no thread is written

### Requirement: The spawn seeds the child context at the anchor

The spawn MUST compose one context message and append it to the child transcript. The message MUST hold the brief, and then a copy of the working-memory render at the moment of the spawn. A later change to the working memory MUST NOT change the seed, because the transcript is append-only.

When the seed write fails after the thread insert, the spawn MUST purge the child. The fault MUST return as typed data, and no context-less report thread survives.

#### Scenario: The seed lands with the thread

- **WHEN** the spawn makes a child for a conversation with a working memory
- **THEN** the child transcript holds one message with the brief and the working-memory render

#### Scenario: The seed is frozen at the anchor

- **GIVEN** a spawned child with its seed
- **WHEN** the working memory of the analysis changes afterward
- **THEN** the seed message of the child does not change

#### Scenario: A failed seed removes the child

- **WHEN** the seed write fails after the thread insert
- **THEN** the spawn purges the child, and the result is typed data that names the fault

### Requirement: The roster of the conversation agent holds one report path

The roster of the conversation agent MUST hold `start_report_session`, and it MUST hold no other report tool. The prompt of the conversation agent MUST describe the session path, and it MUST describe no other report flow.

#### Scenario: The roster holds the start tool

- **WHEN** the assembled conversation agent lists its tools
- **THEN** `start_report_session` is present, and no other report tool is present

#### Scenario: The prompt describes one path

- **WHEN** a reviewer reads the report section of the conversation prompt
- **THEN** the section names `start_report_session`, and no other report tool is named

### Requirement: The thin-delta advice steers to the existing report chat

The delta MUST count the user turns of the parent past the greatest anchor of its report children. A user turn is a message that opens a turn, and it is not a synthetic record. When the count is one or less, the tool MUST NOT spawn. The tool MUST return an `existing-session` arm that names the report child with the greatest anchor. When two children share the greatest anchor, the newest `created_at` MUST win. The advice MUST read no model judgment.

The count admits one turn, because the ask that made the newest child is itself a user turn past the anchor. The turn appends after the loop of the turn runs, thus the anchor of a child never counts the ask that made it. A count over the raw sequence would name each report child stale one turn after the spawn.

The input MUST carry one optional override field. A true value MUST skip the advice, and the spawn proceeds. A parent with no report child MUST NOT advise. An archived report child MUST NOT advise, because a steer into hidden state is not permitted.

The eyes gate MUST run before the advice. A composition without eyes is a permanent condition, and the advice must not mask it.

#### Scenario: The eyes gate wins over the advice

- **GIVEN** a composition without eyes, and a report child at the transcript end
- **WHEN** the agent calls the tool
- **THEN** the result carries the `no_browser` arm, and no advice returns

#### Scenario: A tie on the anchor names the newest child

- **GIVEN** two report children that share the greatest anchor, at the transcript end
- **WHEN** the agent calls the tool without the override
- **THEN** the `existing-session` arm names the child with the newest `created_at`

#### Scenario: A child at the transcript end advises

- **GIVEN** a report child whose anchor equals the latest seq of the parent
- **WHEN** the agent calls the tool without the override
- **THEN** the result carries the `existing-session` arm that names that child, and no thread is written

#### Scenario: The turn of the spawning ask does not clear the advice

- **GIVEN** a report child, and the one user turn that made it past its anchor
- **WHEN** the agent calls the tool without the override
- **THEN** the result carries the `existing-session` arm that names that child

#### Scenario: A second user turn clears the advice

- **GIVEN** a report child, and two user turns of the parent past its anchor
- **WHEN** the agent calls the tool
- **THEN** the spawn proceeds, and the result carries the new thread id

#### Scenario: A synthetic record does not clear the advice

- **GIVEN** a report child, and one host record of the parent past its anchor
- **WHEN** the agent calls the tool
- **THEN** the result carries the `existing-session` arm, because a record is no user turn

#### Scenario: The override skips the advice

- **GIVEN** a report child at the transcript end
- **WHEN** the agent calls the tool with the override set to true
- **THEN** the spawn proceeds, and the result carries the new thread id

#### Scenario: A parent with no report child never advises

- **GIVEN** a live conversation that holds turns and no report child
- **WHEN** the agent calls the tool
- **THEN** the spawn proceeds, and the result carries the new thread id
