# report-session-spawn Delta

## ADDED Requirements

### Requirement: The conversation agent starts a report session through one tool

The conversation agent MUST offer the tool `start_report_session`. The tool MUST run the spawn operation with the thread id of the call scope as the parent. The tool MUST NOT accept a parent id as input.

The input MUST carry the intent brief: `objective`, `audience`, `angle`, optional `exclusions`, and optional `openQuestions`. The brief holds intent only, and no field names a path, a dataset, or a format. The input MUST also carry the optional override of the zero-delta advice.

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

The roster of the conversation agent MUST hold `start_report_session`. The roster MUST NOT hold `plan_report`, and it MUST NOT hold `submit_report`. The prompt of the conversation agent MUST describe the session path, and it MUST NOT describe the brief flow.

#### Scenario: The roster holds the start tool and not the pair

- **WHEN** the assembled conversation agent lists its tools
- **THEN** `start_report_session` is present, and neither `plan_report` nor `submit_report` is present

#### Scenario: The prompt describes one path

- **WHEN** a reviewer reads the report section of the conversation prompt
- **THEN** the section names `start_report_session`, and no brief tool is named

### Requirement: The zero-delta advice steers to the existing report chat

When the parent holds no message past the greatest anchor of its report children, the tool MUST NOT spawn. The tool MUST return an `existing-session` arm that names the report child with the greatest anchor. When two children share the greatest anchor, the newest `created_at` MUST win. The advice MUST read no model judgment.

The input MUST carry one optional override field. A true value MUST skip the advice, and the spawn proceeds. A parent with no report child MUST NOT advise. An archived report child MUST NOT advise, because a steer into hidden state is not permitted.

The eyes gate MUST run before the advice. A composition without eyes is a permanent condition, and the advice must not mask it.

#### Scenario: The eyes gate wins over the advice

- **GIVEN** a composition without eyes, and a report child whose anchor equals the latest seq
- **WHEN** the agent calls the tool
- **THEN** the result carries the `no_browser` arm, and no advice returns

#### Scenario: A tie on the anchor names the newest child

- **GIVEN** two report children that share the greatest anchor, at the transcript end
- **WHEN** the agent calls the tool without the override
- **THEN** the `existing-session` arm names the child with the newest `created_at`

#### Scenario: A zero delta advises

- **GIVEN** a report child whose anchor equals the latest seq of the parent
- **WHEN** the agent calls the tool without the override
- **THEN** the result carries the `existing-session` arm that names that child, and no thread is written

#### Scenario: A new message clears the advice

- **GIVEN** a report child whose anchor is below the latest seq of the parent
- **WHEN** the agent calls the tool
- **THEN** the spawn proceeds, and the result carries the new thread id

#### Scenario: The override skips the advice

- **GIVEN** a report child whose anchor equals the latest seq of the parent
- **WHEN** the agent calls the tool with the override set to true
- **THEN** the spawn proceeds, and the result carries the new thread id

#### Scenario: A parent with no report child never advises

- **GIVEN** a live conversation that holds turns and no report child
- **WHEN** the agent calls the tool
- **THEN** the spawn proceeds, and the result carries the new thread id
