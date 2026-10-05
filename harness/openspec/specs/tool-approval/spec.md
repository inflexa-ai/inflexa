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
command or operation, and optional detail), and MAY carry an optional `grantKey`
— a generic key string that keys a standing grant (see the standing-grants
requirement) when the class an `always` blesses is broader than the displayed
`command`. The harness SHALL be agnostic to what is being approved — `ask`
carries no tool- or domain-specific fields; `grantKey` is a generic key, not a
domain field, and the surface SHALL NOT render it.

#### Scenario: A tool pauses on an approval request

- **GIVEN** a conversation tool whose `execute` calls `await ctx.ask(request)`
- **WHEN** the request is emitted and no decision has been returned
- **THEN** the tool's `execute` remains suspended and does not proceed to its guarded action

#### Scenario: The request describes the concrete action

- **GIVEN** an `AskRequest` for a tool that will run a specific command
- **WHEN** the surface renders the pending ask
- **THEN** the rendered prompt names the exact operation being approved

#### Scenario: The surface renders the command, never the grant key

- **GIVEN** an `AskRequest` carrying a `grantKey` distinct from its `command`
- **WHEN** the surface renders the pending ask
- **THEN** it renders the `command`, and the `grantKey` never appears in the rendered prompt

### Requirement: The approval reply is a three-variant decision

`AskReply` MUST be one of `once`, `always`, or `reject`, and it is never a
boolean. `once` MUST approve the one pending invocation. `always` MUST approve
the pending invocation, and it MUST record a standing grant for the matched
action. That grant covers one user inside one analysis, and it lasts the
lifecycle of the analysis (see the standing-grants requirement). `reject` MUST
deny, and it can carry model-facing feedback text.

#### Scenario: Approve-once returns and the tool proceeds

- **WHEN** the user answers a pending ask with `once`
- **THEN** `ctx.ask` returns the `once` reply and the tool proceeds with its guarded action

#### Scenario: Reject carries optional feedback

- **WHEN** the user answers a pending ask with `reject` and feedback text
- **THEN** the reply carries that feedback for the model-facing denial

### Requirement: An always reply records a standing grant for one user

An `always` reply MUST persist a grant row (`cortex_ask_grants`) keyed by the
analysis, the user, and the ask's grant key. The grant key is
`AskRequest.grantKey` when the request carries one, and the `command` when it
does not. The user is the `userId` of the `AskContext` that raised the ask, and
not the caller that sends the answer. What the user approved as `always` MUST
grant exactly that key and nothing broader. A tool that keys a grant more
broadly than the displayed `command` MUST make that breadth visible in the
request content it renders.

When `ctx.ask` runs and a matching grant exists — the same analysis, the same
user, and the same grant key — it MUST short-circuit with no pause. No prompt
reaches a surface. The ask MUST still be recorded in `cortex_asks` as
`resolved`, thus the ledger stays a complete audit of every approval-gated
action. A grant MUST last for the lifecycle of its analysis, and it MUST survive
a process restart. A grant MUST never apply to another analysis, and it MUST
never apply to another user.

#### Scenario: A matching grant auto-approves without pausing

- **GIVEN** an analysis in which an earlier ask for a given grant key was answered `always`
- **WHEN** a tool calls `ctx.ask` for the same grant key, in that analysis, for the same user
- **THEN** `ctx.ask` returns approved without surfacing a prompt, and a `resolved` ledger row records the invocation

#### Scenario: A grant does not cross users

- **GIVEN** an `always` grant one user recorded in an analysis
- **WHEN** a tool calls `ctx.ask` for the same grant key in that analysis, for a different user
- **THEN** the ask pauses for a decision as if no grant existed

#### Scenario: The grant carries the user of the ask, not the answerer

- **GIVEN** a pending ask raised for user `U`
- **WHEN** any caller answers that ask `always`
- **THEN** the recorded grant carries `U`, and a later ask for `U` short-circuits

#### Scenario: A grant matches on the grant key, not the displayed command

- **GIVEN** an analysis where an ask with command `C1` and grant key `K` was answered `always`
- **WHEN** a tool calls `ctx.ask` with a different command `C2` but the same grant key `K`, for the same user
- **THEN** `ctx.ask` short-circuits and returns approved without surfacing a prompt

#### Scenario: An absent grant key falls back to the command

- **GIVEN** an ask with no `grantKey` answered `always`
- **WHEN** a tool calls `ctx.ask` with the same `command` in that analysis, for the same user
- **THEN** the grant short-circuits the prompt, exactly as when the grant key equals the command

#### Scenario: A grant survives a process restart

- **GIVEN** an analysis with a recorded `always` grant and a restarted harness process
- **WHEN** a tool calls `ctx.ask` for the granted key, for the same user
- **THEN** the grant still short-circuits the prompt

#### Scenario: A grant does not cross analyses

- **GIVEN** an `always` grant recorded in one analysis
- **WHEN** a tool calls `ctx.ask` for the same grant key and the same user in a different analysis
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
leaving a permanently-pending row. The sweep SHALL expire only pending asks older
than a max age (default 24 hours, overridable per call via
`sweepExpired(maxAgeMs?)`), so a boot — including each pod of a rolling
deployment — cannot expire an ask a live process is still polling. The sweep's
return count SHALL reflect only the rows it swept.

#### Scenario: Turn abort aborts a pending ask

- **GIVEN** a suspended `ctx.ask` on a turn whose `ctx.signal` fires
- **WHEN** the abort is observed
- **THEN** the row becomes `aborted` and `ctx.ask` re-throws the cancellation, so the turn ends through the existing abort path

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

### Requirement: Each ask is raised for one user

`AskContext` MUST carry a required `userId`. The value is an opaque identity
string, and the embedder supplies it for the person that the ask goes to. The
harness MUST NOT derive that identity, because it never reads the `auth`
capability. The harness MUST NOT interpret the value. `ctx.ask` MUST record the
identity on the ledger row (`cortex_asks.user_id`), and it MUST use the identity
for the grant lookup. `pending()` MUST report the identity for each unresolved
ask, thus a host can route an ask to the correct person.

#### Scenario: The ledger row records the user of the turn

- **GIVEN** an `AskContext` bound with a user id
- **WHEN** `ctx.ask` persists its pending row
- **THEN** the row carries that user id

#### Scenario: The pending enumeration reports the user

- **GIVEN** two unresolved asks raised for two different users
- **WHEN** `pending()` is called
- **THEN** each entry carries the user id its ask was raised for
