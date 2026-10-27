# sub-agent-workflows Specification

## Purpose
A sub-agent runs as a child workflow of the workflow of its caller. Each of its calls is a checkpoint, and two sub-agents of one reply run at the same time.

## Requirements

### Requirement: A sub-agent call inside a workflow is a child workflow

Inside a workflow, a tool that runs a sub-agent MUST start one child workflow for each call. The id of the child MUST come from the id of the caller workflow and the id of the tool call. Each model call and each tool call of the sub-agent MUST be a step of the child.

#### Scenario: A recovered planner does not call the model again

- **GIVEN** a planner child that completed two model calls before the host stopped
- **WHEN** the turn recovers
- **THEN** the planner gets the two replies from its checkpoints, and the provider gets no request for them

#### Scenario: A replayed caller finds the same child

- **WHEN** the caller workflow replays the tool call of a sub-agent that completed
- **THEN** the caller gets the result of the same child, and no second child starts

### Requirement: Two sub-agents of one reply run at the same time

When one reply calls two sub-agents, the two children MUST run at the same time. A replay MUST give each call the result of its own child.

#### Scenario: Two reviewers in one round

- **WHEN** the synthesizer calls `literature_reviewer` two times in one reply
- **THEN** the two reviews run at the same time, and each call gets its own review on a replay

### Requirement: A child gives its usage to the total of the turn

The result of a child MUST carry the usage of its model calls. The caller MUST add that usage to the total of the turn. The input of a child MUST hold no credential of a request.

#### Scenario: The turn total holds the planner

- **WHEN** a turn calls `generate_plan`, and the planner makes three model calls
- **THEN** the finish of the turn holds the tokens of the root calls and of the three planner calls

### Requirement: The synthesis of a run starts its reviewers as children

The synthesis of a run MUST run its loop in the workflow body of the run, not inside one step. Thus each reviewer that the synthesizer calls is a child workflow, and a recovery of the synthesis repeats no completed call.

#### Scenario: A crash during the synthesis

- **GIVEN** a synthesis that completed one review before the host stopped
- **WHEN** the run recovers
- **THEN** the synthesis gets the review from the child, and the reviewer makes no model request again
