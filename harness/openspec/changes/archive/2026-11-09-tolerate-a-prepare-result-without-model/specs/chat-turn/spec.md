## MODIFIED Requirements

### Requirement: A turn runs on the model of its thread

A chat turn MUST read the `model` of its thread before its run. A turn workflow MUST read it in its `chat-turn.prepare` step, thus a replay uses the recorded value. When the thread names a model, the root loop of the turn MUST run on the provider of that model. `withModel` of the turn provider gives that provider. The compaction rules of the turn MUST read the context window of that provider.

When the thread names no model, the turn MUST run on the provider of the host. When the provider of the host has no `withModel` member, the turn MUST run on the provider of the host. The turn MUST then log a warning that names the model of the thread.

A recorded `chat-turn.prepare` result with no `model` key names no model. A turn that started before the step recorded the model replays such a result, and it MUST run on the provider of the host.

#### Scenario: A pinned thread starts on its model

- **GIVEN** a thread whose model is `claude-opus-5`
- **AND** a turn provider on the model `claude-opus-5-5` with a `withModel` member
- **WHEN** a turn runs on the thread
- **THEN** the first request of the turn goes to the provider of `claude-opus-5`

#### Scenario: A thread with no model starts on the model of the host

- **WHEN** a turn runs on a thread whose model is null
- **THEN** the first request goes to the provider of the host

#### Scenario: A replayed prepare result with no model runs on the model of the host

- **GIVEN** a thread whose model is `claude-opus-5`
- **AND** a turn provider on the model `claude-opus-5-5` with a `withModel` member
- **AND** a turn whose recorded `chat-turn.prepare` result has no `model` key
- **WHEN** a recovery continues the turn
- **THEN** the next request of the turn goes to the provider of the host
- **AND** the turn ends as `done`
