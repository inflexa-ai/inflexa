## RENAMED Requirements

- FROM: `### Requirement: An always reply records an analysis-scoped standing grant`
- TO: `### Requirement: An always reply records a standing grant for one user`

## ADDED Requirements

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

## MODIFIED Requirements

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
