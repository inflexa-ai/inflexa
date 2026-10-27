## ADDED Requirements

### Requirement: A tool declares its approval before it runs

A tool MUST be able to declare an approval hook. The hook gets the input of the call and the context, and it gives an `AskRequest` or nothing. The hook can read the disk and the database, and it MUST NOT change them. The loop MUST run the hook after the call policy and before `execute`. A call whose hook gives nothing MUST run with no ask.

`execute` MUST check its input again when it runs. When a fact that the approval saw changed, `execute` MUST fail with an error result, and it MUST NOT act.

#### Scenario: A command that needs approval waits before it runs

- **GIVEN** a tool whose hook gives a request for the input of the call
- **WHEN** the model calls the tool
- **THEN** the ask row is `pending` and the `data-ask` part reaches the stream before `execute` starts

#### Scenario: A command with a standing grant runs with no ask

- **GIVEN** a grant of the user for the grant key of the request
- **WHEN** the model calls the tool
- **THEN** the call runs, and no ask row is written

### Requirement: The wait for an approval is durable

Inside a turn workflow, the turn MUST wait for the answer of an ask with a durable wait of the workflow, up to the time limit of the ask. The answer of the host MUST reach the waiting turn by the ask id. A wait MUST NOT run inside a step.

#### Scenario: An answer after a crash

- **GIVEN** a turn that waits for an answer, and then the host stopped and started again, and the host function gives the credential of the turn
- **WHEN** the turn recovers and the user answers `once`
- **THEN** the call runs, and the ask row is `resolved`

#### Scenario: An ask that nobody answers

- **WHEN** the time limit of a pending ask ends
- **THEN** the ask row is `expired`, and the call gets a denied result

### Requirement: A denial gives the call a denied result and stops the turn

A `reject` answer and an expired ask MUST give the call an `execution-denied` result with the feedback of the user. The turn MUST stop after the calls of the same reply complete, and it MUST NOT make a model request after the denial. `once` and `always` MUST let the call run.

#### Scenario: A rejected command

- **WHEN** the user answers `reject` with the feedback "not this file"
- **THEN** the call result is denied with that feedback, the tool does not run, and no model request follows

## REMOVED Requirements

### Requirement: A conversation tool requests user approval through ctx.ask

**Reason**: The approval is decided before `execute`, through the approval hook of the tool. A tool does not ask from inside `execute`.

**Migration**: Move the request of the tool from `execute` into its approval hook. Check the input again in `execute`.

### Requirement: A rejected ask throws to end the turn

**Reason**: A tool does not ask from inside `execute`, thus no ask throws into a tool.

**Migration**: Refer to "A denial gives the call a denied result and stops the turn".

### Requirement: Approval polling never blocks a durable step

**Reason**: The chat turn is a workflow, and its wait is a durable wait of the workflow body, not a poll inside a step.

**Migration**: Refer to "The wait for an approval is durable".

### Requirement: Ask state lives in a poll-backed ledger with the database as the single source of truth

**Reason**: The decision reaches the turn as a message to its workflow. The ledger row stays the record of each ask, but no poll reads it.

**Migration**: Refer to "The wait for an approval is durable". The `answer` call writes the row and sends the reply to the turn.

## MODIFIED Requirements

### Requirement: Approval is deny-by-default when unwired

An approval that no surface can answer MUST be denied. A loop outside a turn workflow, for example a step agent or a test, MUST deny each request of an approval hook. It MUST NOT wait on a surface that cannot answer.

#### Scenario: An unwired host denies every ask

- **GIVEN** a loop that runs outside a turn workflow
- **WHEN** the approval hook of a tool gives a request
- **THEN** the call gets a denied result rather than a wait

### Requirement: The approval reply is a three-variant decision

`AskReply` MUST be one of `once`, `always`, or `reject`, and it is never a boolean. `once` MUST approve the one pending invocation. `always` MUST approve the pending invocation, and it MUST record a standing grant for the matched action. That grant covers one user inside one analysis, and it lasts the lifecycle of the analysis (see the standing-grants requirement). `reject` MUST deny, and it can carry model-facing feedback text.

#### Scenario: Approve-once returns and the tool proceeds

- **WHEN** the user answers a pending ask with `once`
- **THEN** the loop approves the call, and the tool runs its guarded action

#### Scenario: Reject carries optional feedback

- **WHEN** the user answers a pending ask with `reject` and feedback text
- **THEN** the reply carries that feedback for the model-facing denial

### Requirement: An always reply records a standing grant for one user

When an ask is answered `always`, the harness MUST record a standing grant. The key of the grant is the analysis, the user, and the grant key of the ask. The grant key is `AskRequest.grantKey` when the request carries one, and the `command` when it does not. The user is the user of the scope that raised the ask, and not the caller that sends the answer. What the user approved as `always` MUST grant exactly that key and nothing broader. A tool that keys a grant more broadly than the displayed `command` MUST make that breadth visible in the request content that it renders.

When a turn raises an ask and a matching grant exists, the raise MUST settle the ask with no pause. The same analysis, the same user, and the same grant key match. No prompt reaches a surface. The ask MUST still be recorded in `cortex_asks` as `resolved`, thus the ledger stays a complete audit of each approval-gated action. The turn MUST emit one `data-ask` part that is already settled, with `status: "resolved"` and `reply: "always"`, and no pending part before it. A grant MUST last for the lifecycle of its analysis, and it MUST survive a process restart. A grant MUST never apply to another analysis or to another user.

#### Scenario: A matching grant auto-approves without pausing

- **GIVEN** an analysis in which an earlier ask for a given grant key was answered `always`
- **WHEN** a turn raises an ask for the same grant key, in that analysis, for the same user
- **THEN** the call runs without a prompt, and a `resolved` ledger row records the invocation
- **AND** the one `data-ask` part of the turn has `status: "resolved"` and `reply: "always"`

#### Scenario: A grant does not cross users

- **GIVEN** an `always` grant that one user recorded in an analysis
- **WHEN** a turn raises an ask for the same grant key in that analysis, for a different user
- **THEN** the ask waits for a decision as if no grant existed

#### Scenario: The grant carries the user of the ask, not the answerer

- **GIVEN** a pending ask raised for user `U`
- **WHEN** any caller answers that ask `always`
- **THEN** the recorded grant carries `U`, and a later ask for `U` settles at its raise

#### Scenario: A grant matches on the grant key, not the displayed command

- **GIVEN** an analysis where an ask with command `C1` and grant key `K` was answered `always`
- **WHEN** a turn raises an ask with a different command `C2` but the same grant key `K`, for the same user
- **THEN** the raise settles the ask with no prompt

#### Scenario: An absent grant key falls back to the command

- **GIVEN** an ask with no `grantKey` answered `always`
- **WHEN** a turn raises an ask with the same `command` in that analysis, for the same user
- **THEN** the grant settles the ask with no prompt, exactly as when the grant key equals the command

#### Scenario: A grant survives a process restart

- **GIVEN** an analysis with a recorded `always` grant and a restarted harness process
- **WHEN** a turn raises an ask for the granted key, for the same user
- **THEN** the grant still settles the ask with no prompt

#### Scenario: A grant does not cross analyses

- **GIVEN** an `always` grant recorded in one analysis
- **WHEN** a turn raises an ask for the same grant key and the same user in a different analysis
- **THEN** the ask waits for a decision as if no grant existed

### Requirement: The embedder answers and enumerates asks out of band

The harness MUST give `answer(id, reply)` on the chat turns, and `pending()` on the ask gateway. `answer` MUST update the addressed ledger row only when it is still `pending`. It MUST return a discriminated outcome: `applied` (the decision landed), `not_found` (no such id), or `already_terminal` (the row had already left `pending`). Thus a duplicate or stale answer is a reported no-op, never an override and never silent. An applied answer MUST reach the turn that waits for the ask. `pending()` MUST enumerate the unresolved asks. Both MUST operate by id, thus the caller that answers an ask need not be the process that raised it.

#### Scenario: Answering by id resolves a suspended ask

- **GIVEN** a turn that waits for an ask with a known ledger id
- **WHEN** `answer(id, reply)` is called
- **THEN** the ledger row reaches the corresponding terminal status, and the turn continues with that reply

#### Scenario: A duplicate answer is a reported no-op

- **GIVEN** an ask already answered `once`
- **WHEN** `answer(id, …)` is called again for the same id
- **THEN** the row is unchanged and the call returns `already_terminal`

#### Scenario: An unknown id is reported

- **WHEN** `answer` is called with an id no ledger row carries
- **THEN** the call returns `not_found` and no row is written

#### Scenario: Pending asks are enumerable

- **GIVEN** two unresolved asks
- **WHEN** `pending()` is called
- **THEN** it returns both, and excludes any ask that has reached a terminal status

### Requirement: The ask status machine covers approval, denial, abort, and expiry

An ask MUST move from `pending` to exactly one terminal status: `resolved` (approved `once` or `always`), `rejected`, `aborted`, or `expired`. A pending ask whose turn stops MUST become `aborted`, and the turn MUST end through its abort path. A pending ask that no answer reaches in the wait of its turn MUST become `expired`, and the loop MUST deny its call. A pending ask that a dead process left MUST be swept to `expired` at boot. The sweep MUST expire only pending asks older than a max age (default 24 hours, overridable per call through `sweepExpired(maxAgeMs?)`). Thus a boot, also of each pod of a rolling deployment, cannot expire an ask that a live turn waits for. The return count of the sweep MUST reflect only the rows that it swept.

#### Scenario: Turn abort aborts a pending ask

- **GIVEN** a turn that waits for an ask
- **WHEN** the host stops the turn
- **THEN** the row becomes `aborted`, and the turn ends through its abort path

#### Scenario: An orphaned pending ask is expired at boot

- **GIVEN** a `pending` row older than the sweep max age, left by a prior process with no live turn awaiting it
- **WHEN** the harness boots and sweeps the ledger
- **THEN** that row becomes `expired`

#### Scenario: A live pending ask survives a boot sweep

- **GIVEN** a fresh `pending` row within the sweep max age
- **WHEN** another process boots and sweeps the ledger
- **THEN** the row stays `pending` and the sweep count excludes it

#### Scenario: The sweep count reflects only swept rows

- **GIVEN** one `pending` row older than the max age and one fresh `pending` row
- **WHEN** the ledger is swept
- **THEN** the sweep returns 1, the stale row is `expired`, and the fresh row stays `pending`

### Requirement: A pending ask is surfaced as a harness-defined chat part

The harness MUST define a `data-ask` chat part in its part contracts (type, schema, and part-registry entry). A turn MUST emit it when a call waits for an approval. The part MUST carry the ask id, the request content, and the current status. The request content includes the exact command or operation that the user approves. The id is what a surface passes back to `answer`. The part MUST be registered as reconciling, and the turn emits it again under the same id when the ask reaches a terminal status. Thus a reader folds the pending part into its outcome, latest-wins. When some asks are pending at the same time, each MUST be its own part under its own id. Thus a surface can stack them, and the user can answer them one by one.

The terminal part MUST carry `reply`, the kind of the reply that the ledger row recorded:

- A `resolved` ask carries `once` or `always`.
- A `rejected` ask carries `reject`.
- A `pending`, `aborted`, or `expired` part carries no `reply`.

The part MUST NOT carry the feedback of a rejection, because that text is for the model.

#### Scenario: The pending part names the exact command

- **WHEN** a call of a turn waits for an approval
- **THEN** a `data-ask` part is emitted carrying the ask id, the exact command being approved, and a pending status

#### Scenario: Resolution reconciles the part

- **GIVEN** an emitted pending `data-ask` part
- **WHEN** the ask reaches a terminal status
- **THEN** a part with the same id carries the terminal status, and reconciling readers keep only the latest

#### Scenario: An always approval shows its reply kind

- **GIVEN** an emitted pending `data-ask` part
- **WHEN** the user answers `always`
- **THEN** the terminal part has the status `resolved` and the `reply` `always`

#### Scenario: A rejection shows its reply kind and no feedback

- **GIVEN** an emitted pending `data-ask` part
- **WHEN** the user answers `reject` with feedback
- **THEN** the terminal part has the status `rejected` and the `reply` `reject`, and it holds no feedback

#### Scenario: Concurrent asks stack as distinct parts

- **GIVEN** two calls of one turn that wait for approvals
- **WHEN** the parts are emitted
- **THEN** each ask is a distinct part under its own id, answerable independently

### Requirement: Each ask is raised for one user

The scope of an ask MUST carry a required `userId`. The value is an opaque identity string: the user of the session of the turn. The harness MUST NOT derive that identity, because it never reads the `auth` capability. The harness MUST NOT interpret the value. The raise MUST record the identity on the ledger row (`cortex_asks.user_id`), and it MUST use the identity for the grant lookup. `pending()` MUST report the identity for each unresolved ask, thus a host can route an ask to the correct person.

#### Scenario: The ledger row records the user of the turn

- **GIVEN** a turn whose session names a user
- **WHEN** the turn raises an ask
- **THEN** the row carries that user id

#### Scenario: The pending enumeration reports the user

- **GIVEN** two unresolved asks raised for two different users
- **WHEN** `pending()` is called
- **THEN** each entry carries the user id its ask was raised for
