## MODIFIED Requirements

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

### Requirement: An always reply records an analysis-scoped standing grant

An `always` reply SHALL persist a grant row (`cortex_ask_grants`) keyed by the
analysis and the ask's grant key — `AskRequest.grantKey` when present, otherwise
its `command`. What the user approved as `always` SHALL grant exactly that key
and nothing broader; a tool that keys a grant more broadly than the displayed
`command` SHALL make that breadth visible in the request content it renders. When
`ctx.ask` is invoked and a matching grant (same analysis, same grant key) exists,
it SHALL short-circuit without pausing: no prompt is surfaced, and the ask SHALL
still be recorded in `cortex_asks` as `resolved` so the ledger remains a complete
audit of every approval-gated action. A grant SHALL last for the lifecycle of its
analysis — surviving process restarts — and SHALL never apply to any other
analysis.

#### Scenario: A matching grant auto-approves without pausing

- **GIVEN** an analysis in which an earlier ask for a given grant key was answered `always`
- **WHEN** a tool calls `ctx.ask` for the same grant key in that analysis
- **THEN** `ctx.ask` returns approved without surfacing a prompt, and a `resolved` ledger row records the invocation

#### Scenario: A grant matches on the grant key, not the displayed command

- **GIVEN** an analysis where an ask with command `C1` and grant key `K` was answered `always`
- **WHEN** a tool calls `ctx.ask` with a different command `C2` but the same grant key `K` in that analysis
- **THEN** `ctx.ask` short-circuits and returns approved without surfacing a prompt

#### Scenario: An absent grant key falls back to the command

- **GIVEN** an ask with no `grantKey` answered `always`
- **WHEN** a tool calls `ctx.ask` with the same `command` in that analysis
- **THEN** the grant short-circuits the prompt, exactly as when the grant key equals the command

#### Scenario: A grant survives a process restart

- **GIVEN** an analysis with a recorded `always` grant and a restarted harness process
- **WHEN** a tool calls `ctx.ask` for the granted key in that analysis
- **THEN** the grant still short-circuits the prompt

#### Scenario: A grant does not cross analyses

- **GIVEN** an `always` grant recorded in one analysis
- **WHEN** a tool calls `ctx.ask` for the same grant key in a different analysis
- **THEN** the ask pauses for a decision as if no grant existed
