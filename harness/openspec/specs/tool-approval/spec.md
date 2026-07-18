# tool-approval Specification

## Purpose

Define the harness's in-chat tool-approval primitive: the `ctx.ask` a
conversation tool calls to pause for an explicit user decision, the three-variant
reply that decision carries, the poll-based ledger that makes the database the
single source of truth for ask state, the analysis-scoped standing grants behind
`always`, and the `data-ask` chat part a surface renders and answers. The
primitive is generic — the harness never learns what a given tool is approving.
It is realized behind a deny-by-default seam so an unwired or non-interactive
host is safe, and it exposes an outward `answer`/`pending` API an embedder
drives over whatever transport it runs.

## Requirements

### Requirement: A conversation tool requests user approval through ctx.ask

`ToolContext` SHALL expose `ask(request: AskRequest) => Promise<AskReply>`. A
conversation tool SHALL call `ctx.ask` to pause its `execute` until the user
returns a decision. `AskRequest` SHALL carry the human-facing content the surface
renders to describe the exact action being approved (a title, the concrete
command or operation, and optional detail). The harness SHALL be agnostic to what
is being approved — `ask` carries no tool- or domain-specific fields.

#### Scenario: A tool pauses on an approval request

- **GIVEN** a conversation tool whose `execute` calls `await ctx.ask(request)`
- **WHEN** the request is emitted and no decision has been returned
- **THEN** the tool's `execute` remains suspended and does not proceed to its guarded action

#### Scenario: The request describes the concrete action

- **GIVEN** an `AskRequest` for a tool that will run a specific command
- **WHEN** the surface renders the pending ask
- **THEN** the rendered prompt names the exact operation being approved

### Requirement: The approval reply is a three-variant decision

`AskReply` SHALL be one of `once`, `always`, or `reject` — never a boolean.
`once` SHALL approve the single pending invocation. `always` SHALL approve the
pending invocation AND record a standing grant for the matched action, scoped to
the analysis and lasting its lifecycle (see the standing-grants requirement).
`reject` SHALL deny and MAY carry model-facing feedback text.

#### Scenario: Approve-once returns and the tool proceeds

- **WHEN** the user answers a pending ask with `once`
- **THEN** `ctx.ask` returns the `once` reply and the tool proceeds with its guarded action

#### Scenario: Reject carries optional feedback

- **WHEN** the user answers a pending ask with `reject` and feedback text
- **THEN** the reply carries that feedback for the model-facing denial

### Requirement: An always reply records an analysis-scoped standing grant

An `always` reply SHALL persist a grant row (`cortex_ask_grants`) keyed by the
analysis and the exact action key the `AskRequest` presented for approval — what
the user saw approved is precisely what is granted, nothing broader. When
`ctx.ask` is invoked and a matching grant exists, it SHALL short-circuit without
pausing: no prompt is surfaced, and the ask SHALL still be recorded in
`cortex_asks` as `resolved` so the ledger remains a complete audit of every
approval-gated action. A grant SHALL last for the lifecycle of its analysis —
surviving process restarts — and SHALL never apply to any other analysis.

#### Scenario: A matching grant auto-approves without pausing

- **GIVEN** an analysis in which an earlier ask for a given action was answered `always`
- **WHEN** a tool calls `ctx.ask` for the same action in that analysis
- **THEN** `ctx.ask` returns approved without surfacing a prompt, and a `resolved` ledger row records the invocation

#### Scenario: A grant survives a process restart

- **GIVEN** an analysis with a recorded `always` grant and a restarted harness process
- **WHEN** a tool calls `ctx.ask` for the granted action in that analysis
- **THEN** the grant still short-circuits the prompt

#### Scenario: A grant does not cross analyses

- **GIVEN** an `always` grant recorded in one analysis
- **WHEN** a tool calls `ctx.ask` for the same action in a different analysis
- **THEN** the ask pauses for a decision as if no grant existed

### Requirement: Ask state lives in a poll-backed ledger with the database as the single source of truth

`ctx.ask` SHALL persist each request as a ledger row (`cortex_asks`) with a
`uuidv7` id and a `pending` status BEFORE awaiting a decision, then SHALL resolve
the decision by polling that row until it reaches a terminal status. The harness
SHALL NOT maintain a separate in-memory registry of pending-ask resolvers: the
ledger row is the only place ask state lives. `answer` SHALL be a single
write to that row. A "not yet fulfilled" ask SHALL be represented as a persisted
`pending` row, not as an absence.

#### Scenario: An ask is persisted as pending before it is awaited

- **WHEN** `ctx.ask` is invoked
- **THEN** a `cortex_asks` row with a `uuidv7` id and status `pending` exists before any decision is returned

#### Scenario: A decision is observed by polling the row

- **GIVEN** a suspended `ctx.ask` polling its `pending` row
- **WHEN** the row's status transitions to a terminal value out of band
- **THEN** `ctx.ask` returns the reply recorded on that row without any in-memory resolver being invoked

### Requirement: The embedder answers and enumerates asks out of band

The harness SHALL export `answer(id, reply)` and `pending()`. `answer` SHALL
update the addressed ledger row only when it is still `pending`, and SHALL return
a discriminated outcome — `applied` (the decision landed), `not_found` (no such
id), or `already_terminal` (the row had already left `pending`) — so a duplicate
or stale answer is a reported no-op, never an override and never silent.
`pending()` SHALL enumerate the unresolved asks. Both SHALL operate by id against
the ledger, so the caller answering an ask need not be the same in-process
context that raised it.

#### Scenario: Answering by id resolves a suspended ask

- **GIVEN** a suspended `ctx.ask` with a known ledger id
- **WHEN** `answer(id, reply)` is called
- **THEN** the ledger row reaches the corresponding terminal status and the suspended `ctx.ask` returns that reply

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

An ask SHALL move from `pending` to exactly one terminal status:
`resolved` (approved `once` or `always`), `rejected`, `aborted`, or `expired`.
A pending ask whose turn is cancelled via `ctx.signal` SHALL become `aborted`,
and its `ctx.ask` SHALL stop polling and re-throw the cancellation so the loop's
existing turn-abort path engages unchanged. A pending ask left by a process that
is no longer running SHALL be swept to `expired` at boot, because its turn's
in-memory continuation cannot be resumed — the ledger records the loss rather than
leaving a permanently-pending row.

#### Scenario: Turn abort aborts a pending ask

- **GIVEN** a suspended `ctx.ask` on a turn whose `ctx.signal` fires
- **WHEN** the abort is observed
- **THEN** the row becomes `aborted` and `ctx.ask` re-throws the cancellation, so the turn ends through the existing abort path

#### Scenario: An orphaned pending ask is expired at boot

- **GIVEN** a `pending` row left by a prior process with no live turn awaiting it
- **WHEN** the harness boots and sweeps the ledger
- **THEN** that row becomes `expired`

### Requirement: A pending ask is surfaced as a harness-defined chat part

The harness SHALL define a `data-ask` chat part in its part contracts (interface,
schema, and part-registry entry) and `ctx.ask` SHALL emit it when a request
pauses. The part SHALL carry the ask id, the request content — including the
exact command or operation being approved — and the current status; the id is
what a surface passes back to `answer`. The part SHALL be registered as
reconciling, re-emitted under the same id when the ask reaches a terminal status,
so readers fold the pending part into its outcome latest-wins. When multiple
asks are pending concurrently, each SHALL be its own part under its own id, so a
surface can stack them and the user can answer them one by one.

#### Scenario: The pending part names the exact command

- **WHEN** `ctx.ask` pauses on a request
- **THEN** a `data-ask` part is emitted carrying the ask id, the exact command being approved, and a pending status

#### Scenario: Resolution reconciles the part

- **GIVEN** an emitted pending `data-ask` part
- **WHEN** the ask reaches a terminal status
- **THEN** a part with the same id carries the terminal status, and reconciling readers keep only the latest

#### Scenario: Concurrent asks stack as distinct parts

- **GIVEN** two tools pausing on asks in the same turn
- **WHEN** the parts are emitted
- **THEN** each ask is a distinct part under its own id, answerable independently

### Requirement: A rejected ask throws to end the turn

When the decision is `reject`, `ctx.ask` SHALL throw (an `AskRejectedError`
carrying the feedback) rather than return, so a tool does not need to inspect the
reply to know it was denied. The harness agent loop maps that throw to a
model-visible denial and terminates the turn (see the harness-agent-loop spec).
An approval (`once`/`always`) SHALL return normally.

#### Scenario: A rejection throws rather than returns

- **WHEN** a pending ask is answered `reject`
- **THEN** the awaiting `ctx.ask` throws an error carrying the feedback rather than returning a reply value

### Requirement: Approval is deny-by-default when unwired

The harness SHALL ship an `Ask` seam whose default realization (`UnavailableAsk`)
denies every request, and SHALL resolve `ctx.ask` to that default when an embedder
wires no realization. A tool that calls `ctx.ask` in a workflow context or in a
headless embedder SHALL therefore be denied, never left waiting on a surface that
cannot answer.

#### Scenario: An unwired host denies every ask

- **GIVEN** a runtime with no `ask` realization wired
- **WHEN** a tool calls `ctx.ask`
- **THEN** the call is denied by the default realization rather than suspending indefinitely

### Requirement: Approval polling never blocks a durable step

The ask poll SHALL run as ordinary database reads on the in-process chat path and
SHALL NOT be implemented as a durable workflow wait (`DBOS.recv`). Approval is a
conversation-path primitive; it SHALL NOT be invoked as a blocking human wait
inside a DBOS step context.

#### Scenario: The poll is not a durable receive

- **WHEN** `ctx.ask` resolves a decision
- **THEN** it does so by polling the ledger, not by a `DBOS.recv`, and does not run inside a DBOS step context
