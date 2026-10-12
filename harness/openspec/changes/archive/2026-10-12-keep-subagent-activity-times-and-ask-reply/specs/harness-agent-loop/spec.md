## ADDED Requirements

### Requirement: A nested loop names its tool call on each event

The loop SHALL set `invocationId` on the source of each event that it emits when `RunAgentOptions.invocationId` has a value. The value is the id of the tool call that runs the loop, or the workflow id of the attempt for the data-profile loop. A loop with no `invocationId` SHALL emit sources with no `invocationId` key. The `agentId` and the `callPath` of the source SHALL NOT change.

The id SHALL go only into the source of an event. It SHALL NOT go into a model message, a tool result, or a per-turn context record. Thus it adds no token to a model request.

#### Scenario: A sub-agent event names the tool call that runs it

- **GIVEN** a sub-agent tool whose call id is `t1`, and that runs a loop with `invocationId` `t1`
- **WHEN** the sub-agent loop emits a `tool-started` event
- **THEN** the source of the event has the `invocationId` `t1`, and its `callPath` is the call path of the sub-agent

#### Scenario: A root loop emits no invocation id

- **GIVEN** a loop that runs with no `invocationId`
- **WHEN** the loop emits an event
- **THEN** the source of the event has no `invocationId` key

## MODIFIED Requirements

### Requirement: Sub-agent delegation derives a child Session

A sub-agent tool SHALL invoke `runAgent` with a child `Session` derived via `forSubAgent` — `agentId` set to the sub-agent and `callPath` extended — leaving the parent `Session` unmutated. The sub-agent tool SHALL pass its `ctx.invocationId` as the `invocationId` of the loop. The sub-agent's messages SHALL NOT be persisted.

The display projection of the turn SHALL hold only a per-call record of each tool call of the sub-agent: the agent, the call path, the tool name, the one-line detail, the times, and the outcome (see the conversation-display-storage capability). That record SHALL NOT hold a message, a tool input, or a tool output of the sub-agent.

#### Scenario: The literature-reviewer tool runs with a derived Session

- **GIVEN** the conversation loop dispatches the `literatureReviewer` tool
- **WHEN** the tool invokes `runAgent`
- **THEN** the child `Session` has `callPath` extended with `"literature-reviewer"`, the parent `Session` is unchanged, and the child transcript is not written to any message store

#### Scenario: The display keeps a call record and no message of the sub-agent

- **GIVEN** a sub-agent that replies with text and makes one tool call
- **WHEN** the turn is stored
- **THEN** the display projection holds one entry for the tool call, the entry holds no text of the sub-agent, and no message of the sub-agent is stored
