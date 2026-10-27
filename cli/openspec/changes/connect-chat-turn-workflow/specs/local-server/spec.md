## MODIFIED Requirements

### Requirement: The chat turn runs apart from its request

`POST {A}/chat` with `{threadId, message}` MUST open one turn through the chat turns of the harness. The harness runs the turn as a workflow, and it makes the id of the turn. The server MUST register the turn when it opens, and send the id in the response header `Inflexa-Turn-Id`. A stop of the server MUST also wait for a turn that still opens.

A refusal before the turn opens MUST be a JSON error:

- 404 for a thread that is absent or of a different analysis
- 409 `conflict` for a thread whose turn still runs
- 500 for a turn that cannot prepare or has no agent

After the open, the stream MUST carry the frames of the turn and of its sub-agents. It MUST end with one `finish` frame for a turn that ended or aborted. It MUST end with one `error` frame for a turn that failed, with the remedy that the server knows.

A client that disconnects MUST stop only the delivery of the frames, never the turn. `GET {T}/turns/:turnId/stream` MUST give the frames of a turn that the registry holds again, from the start of the turn. `POST {T}/turns/:turnId/abort` MUST stop the turn for each client. `GET {T}/turns` and `GET {T}/turns/:turnId` MUST give the running turns and the newest 100 ended turns. Each one has the status, the usage, and the failure detail. The answer of an ask MUST reach the turn that waits for it, through the chat turns of the harness.

At the end of each turn, the server MUST start the flush of the package adds that the turn queued.

#### Scenario: A second client aborts a turn

- **GIVEN** a turn that a TUI started
- **WHEN** a different client sends the abort of its turn id
- **THEN** the turn ends as aborted, and the TUI gets its `finish` frame

#### Scenario: A client leaves during a turn

- **WHEN** the client of a turn closes its connection
- **THEN** the turn runs to its end, and `GET {T}/turns/:turnId` gives its outcome

#### Scenario: A second turn on a thread with a turn that runs

- **GIVEN** a turn that runs on a thread
- **WHEN** a client sends a message to the same thread
- **THEN** the server gives 409 `conflict`, and it starts no turn

#### Scenario: A client reads a turn again

- **GIVEN** a turn that the registry holds
- **WHEN** a client sends `GET {T}/turns/:turnId/stream`
- **THEN** it gets each frame of the turn from its start, and a turn of a different thread gives 404
