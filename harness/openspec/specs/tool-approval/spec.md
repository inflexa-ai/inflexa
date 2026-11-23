# tool-approval Specification

## Purpose

Define the tool-approval primitive of the harness: the approval hook that a
conversation tool declares, the three-variant reply of the user, the ledger of the
asks, the analysis-scoped standing grants behind `always`, and the `data-ask` chat
part that a surface renders and answers. The primitive is generic — the harness
never learns what a tool asks for. A loop with no approver denies each request,
thus an unwired or non-interactive host is safe. An embedder answers through the
outward `answer` and `pending` calls, over the transport that it runs.

## Requirements

### Requirement: The approval reply is a three-variant decision

`AskReply` MUST be one of `once`, `always`, or `reject`, and it is never a boolean. `once` MUST approve the one pending invocation. `always` MUST approve the pending invocation, and it MUST record a standing grant for the matched action. The scope of the request sets the reach of that grant: one user inside one analysis, or one user in each analysis (see the standing-grants requirement). `reject` MUST deny, and it can carry model-facing feedback text.

#### Scenario: Approve-once returns and the tool proceeds

- **WHEN** the user answers a pending ask with `once`
- **THEN** the loop approves the call, and the tool runs its guarded action

#### Scenario: Reject carries optional feedback

- **WHEN** the user answers a pending ask with `reject` and feedback text
- **THEN** the reply carries that feedback for the model-facing denial

### Requirement: An always reply records a standing grant for one user

An `always` answer MUST record a standing grant for the user of the ask and the grant key of the ask. The grant key is `AskRequest.grantKey` when the request carries one, and the `command` otherwise. The user is the user of the scope that raised the ask, not the caller that sends the answer. The grant MUST cover exactly that key. A tool that keys a grant more broadly than the displayed `command` MUST show that breadth in the request content.

`AskRequest.grantScope` sets the reach of the grant. With `analysis` or no scope, the grant MUST apply only in the analysis of the ask. With `user`, the grant MUST apply in each analysis of that user.

When a raise finds a matching grant, it MUST settle the ask with no wait, and no prompt reaches a surface. The ask MUST still be recorded in `cortex_asks` as `resolved`, thus the ledger stays a complete audit. The raise MUST emit one settled `data-ask` part, with `status: "resolved"` and `reply: "always"`, and no pending part before it. A grant MUST survive a process restart. A grant MUST never apply to another user.

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

- **GIVEN** an `always` grant recorded in one analysis for a request with no scope
- **WHEN** a turn raises an ask for the same grant key and the same user in a different analysis
- **THEN** the ask waits for a decision as if no grant existed

#### Scenario: A user grant crosses analyses

- **GIVEN** an `always` grant recorded in one analysis for a request with the scope `user`
- **WHEN** a turn raises an ask for the same grant key and the same user in a different analysis
- **THEN** the raise settles the ask with no prompt

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

An ask MUST move from `pending` to exactly one terminal status: `resolved` (approved `once` or `always`), `rejected`, `aborted`, or `expired`. A pending ask whose turn stops MUST become `aborted`, and the turn MUST end through its abort path. A pending ask that no answer reaches in the wait of its turn MUST become `expired`, and the loop MUST deny its call. A pending ask that a dead process left MUST be swept to `expired` at boot. The sweep MUST NOT expire the ask of a sandbox step, because the step waits until an answer comes. The sweep MUST expire only pending asks older than a max age (default 24 hours, overridable per call through `sweepExpired(maxAgeMs?)`). Thus a boot, also of each pod of a rolling deployment, cannot expire an ask that a live turn waits for. The return count of the sweep MUST reflect only the rows that it swept.

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

#### Scenario: The sweep keeps the ask of a step

- **GIVEN** a `pending` ask of a sandbox step older than the max age
- **WHEN** the ledger is swept
- **THEN** the row stays `pending`

### Requirement: A pending ask is surfaced as a harness-defined chat part

The harness MUST define a `data-ask` chat part in its part contracts (type, schema, and part-registry entry). A turn MUST emit it to the stream of the turn when a call waits for an approval. A sandbox step MUST emit it to the stream of its run. The part MUST carry the ask id, the request content, and the current status. The request content includes the exact command that the user approves. The id is what a surface passes back to `answer`.

The part MUST be registered as reconciling. The workflow emits it again under the same id when the ask reaches a terminal status. Thus a reader folds the pending part into its outcome, latest-wins. When some asks wait at the same time, each MUST be its own part under its own id.

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

#### Scenario: A step ask reaches the stream of its run

- **WHEN** a call of a sandbox step waits for an approval
- **THEN** a pending `data-ask` part reaches the stream of the run of the step

### Requirement: Approval is deny-by-default when unwired

An approval that no surface can answer MUST be denied. A chat turn and a sandbox step each give their loop an approver. A loop with no approver, for example a test, MUST deny each request of an approval hook. It MUST NOT wait on a surface that cannot answer.

#### Scenario: An unwired host denies every ask

- **GIVEN** a loop with no approver
- **WHEN** the approval hook of a tool gives a request
- **THEN** the call gets a denied result rather than a wait

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

A chat turn and a sandbox step MUST wait for the answer of an ask with a durable wait of their workflow. The wait of a chat turn ends at the time limit of the ask. The wait of a sandbox step MUST last until an answer comes, or until the run stops. Each ask row MUST record the id of the workflow that waits. The answer of the host MUST reach that workflow by the ask id. A wait MUST NOT run inside a step of DBOS.

#### Scenario: An answer after a crash

- **GIVEN** a turn that waits for an answer, and then the host stopped and started again, and the host function gives the credential of the turn
- **WHEN** the turn recovers and the user answers `once`
- **THEN** the call runs, and the ask row is `resolved`

#### Scenario: An ask that nobody answers

- **WHEN** the time limit of a pending ask of a chat turn ends
- **THEN** the ask row is `expired`, and the call gets a denied result

#### Scenario: A step waits for an answer

- **GIVEN** a step agent whose call needs an approval
- **WHEN** the user answers the ask `once` by its id
- **THEN** the answer reaches the workflow of the step, and the call runs

#### Scenario: A step waits until the person comes back

- **GIVEN** a step whose ask nobody answers for some hours
- **WHEN** the person answers `once`
- **THEN** the call runs, and the step continues

#### Scenario: A canceled run aborts the asks of its steps

- **GIVEN** a step of a run that waits for an answer
- **WHEN** the run is canceled
- **THEN** the ask row is `aborted`

### Requirement: A denial gives the call a denied result and stops the turn

A `reject` answer and an expired ask MUST give the call an `execution-denied` result with the feedback of the user. In a chat turn, the turn MUST stop after the calls of the same reply complete. It MUST NOT make a model request after the denial. In a sandbox step, the loop MUST continue, thus the step agent can use a different source or report a blocker. `once` and `always` MUST let the call run.

#### Scenario: A rejected command

- **WHEN** the user answers `reject` with the feedback "not this file"
- **THEN** the call result is denied with that feedback, the tool does not run, and no model request follows

#### Scenario: A rejected download in a step

- **GIVEN** a step agent whose download waits for an approval
- **WHEN** the user answers `reject`
- **THEN** the call result is denied, and the step agent makes its next model request

### Requirement: One read gives the pending asks of a list of analyses

The ask gateway MUST give `pendingByAnalyses({ analysisIds, userId?, limit })`. The read MUST give the `pending` asks of the listed analyses, oldest first, as `PendingAsk` entries. The `id` breaks a tie in ascending order. A user id MUST narrow the result to the asks raised for that user. An ask with no user MUST NOT match a user id. The read MUST give at most `limit` entries. The limit MUST be clamped to the range 1 to 200, the bounds of `listRecentThreads`.

The read MUST send one SQL statement, whatever the length of the list. An empty list of analysis ids MUST give an empty result and send no query. A failed query MUST throw at the gateway, the same as `pending()`. `pending()` MUST keep its behavior.

#### Scenario: The pending asks of one person

- **GIVEN** a pending ask of `u1` in analysis `a1`, a pending ask of `u2` in `a1`, and a resolved ask of `u1` in `a1`
- **WHEN** a host calls `pendingByAnalyses` with `[a1]` and the user id `u1`
- **THEN** it gives the pending ask of `u1` only

#### Scenario: An analysis outside the list

- **GIVEN** a pending ask of `u1` in analysis `a2`
- **WHEN** a host calls `pendingByAnalyses` with `[a1]` and the user id `u1`
- **THEN** the result is empty

#### Scenario: One statement serves the list

- **WHEN** a host calls `pendingByAnalyses` for a list of 20 analyses
- **THEN** it sends one query

### Requirement: One read gives the scope of one ask

The ask gateway MUST give `scopeOf(askId)`. The read MUST give `{ analysisId, userId }` of the ask with that id, in each status. The `userId` MUST be `null` for an ask with no user. An unknown id MUST give `null`. The read MUST send one SQL statement. Thus a host can compare the analysis and the person of an ask with its own scope before it answers the ask.

#### Scenario: The scope of a known ask

- **GIVEN** an ask of `u1` in analysis `a1`
- **WHEN** a host calls `scopeOf` with the id of the ask
- **THEN** it gives `{ analysisId: "a1", userId: "u1" }`

#### Scenario: An ask with no user

- **GIVEN** an ask in analysis `a1` whose row has no user
- **WHEN** a host calls `scopeOf` with its id
- **THEN** it gives `{ analysisId: "a1", userId: null }`

#### Scenario: An unknown ask

- **WHEN** a host calls `scopeOf` with an id that no row carries
- **THEN** it gives `null`

### Requirement: The ask of a step names its run and its step

An ask that a sandbox step raises MUST record the id of its run and the id of its step. `pending()` and `pendingByAnalyses` MUST give `runId` and `stepId` for each ask, and `null` for an ask of a chat turn. Thus a surface can show the ask with its run.

#### Scenario: The ask of a step

- **GIVEN** a step `T1S1` of the run `run-1` whose call waits for an approval
- **WHEN** a host reads the pending asks of the analysis
- **THEN** the ask has `runId` `run-1`, `stepId` `T1S1`, and `threadId` `null`

#### Scenario: The ask of a turn

- **WHEN** a host reads the pending ask of a chat turn
- **THEN** the ask has `runId` `null` and `stepId` `null`
