## REMOVED Requirements

### Requirement: The TUI chat turn binds the ask seam; the REPL stays deny-by-default

**Reason**: The chat route of the local server runs each turn, for the TUI and for the REPL alike, and it binds the ask for each turn. The REPL now answers an ask through the server, thus it is no longer deny-by-default.
**Migration**: Refer to "Each chat turn of the server binds the ask seam, and each chat surface answers it".

## MODIFIED Requirements

### Requirement: Answers flow through the gateway and every outcome is handled

The prompt's actions SHALL answer through the local server by ask id (`POST {A}/asks/:askId/answer`),
which hands the answer to the runtime gateway, with the three-variant reply
(`once | always | reject(feedback?)`). An applied answer SHALL advance the queue. A `not_found` or
`conflict` refusal (an unknown ask, or an ask that is already answered) SHALL surface a transient
notice and still advance the queue — the ledger has already moved past that ask, and holding the
prompt open would wedge it. Any other failure, for example a server that does not answer, SHALL
surface an error notice and leave the ask queued, so the user can answer it again.

#### Scenario: A stale answer advances with a notice

- **GIVEN** a docked prompt whose ask was already terminal in the ledger
- **WHEN** the user answers it
- **THEN** a notice reports the stale outcome and the prompt advances to the next pending ask (or unmounts)

#### Scenario: A failed write keeps the ask

- **GIVEN** a docked prompt for a pending ask
- **WHEN** the answer request fails because no server answers
- **THEN** an error notice names the failure, and the prompt keeps the ask, so the user can answer again

## ADDED Requirements

### Requirement: Each chat turn of the server binds the ask seam, and each chat surface answers it

The chat route of the local server SHALL pass the harness turn engine a pre-bound `ask` for each
turn that it runs, for the TUI and for the REPL alike. The `ask` invokes the runtime's ask gateway
with the turn's own scope — analysis id, thread id, the local ask user id, the turn's abort signal,
and the frame sink of the turn's stream — so the gateway's `data-ask` emissions and its poll ride
the same signal and the same stream as every other turn frame. A client SHALL answer an ask through
the server (`POST {A}/asks/:askId/answer`). The TUI answers through the docked prompt. The REPL
SHALL hold the stream at a pending ask of the root agent, ask the user to approve once, approve
always, or reject, and send that answer before it reads on. A canceled REPL prompt SHALL send a
reject.

#### Scenario: A turn carries the bound ask

- **GIVEN** a chat turn that the server runs for an analysis
- **WHEN** the turn engine assembles the agent-loop options
- **THEN** `ask` is present and bound to the runtime gateway with that turn's analysis id, thread id, abort signal, and the frame sink of its stream

#### Scenario: A REPL approval-gated call asks the user

- **GIVEN** a REPL chat turn whose tool calls `ctx.ask`
- **WHEN** the pending `data-ask` frame of the root agent arrives
- **THEN** the REPL prompts with the title and the exact command, sends the choice of the user to the server, and the turn continues with that decision

#### Scenario: A canceled REPL prompt rejects

- **GIVEN** a REPL ask prompt for a pending ask
- **WHEN** the user cancels the prompt
- **THEN** the REPL sends a reject, and the turn ends with the model-visible denial
