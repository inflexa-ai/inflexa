## MODIFIED Requirements

### Requirement: A pending ask is surfaced as a harness-defined chat part

The harness SHALL define a `data-ask` chat part in its part contracts (type,
schema, and part-registry entry) and `ctx.ask` SHALL emit it when a request
pauses. The part SHALL carry the ask id, the request content — including the
exact command or operation being approved — and the current status; the id is
what a surface passes back to `answer`. The part SHALL be registered as
reconciling, re-emitted under the same id when the ask reaches a terminal status,
so readers fold the pending part into its outcome latest-wins. When multiple
asks are pending concurrently, each SHALL be its own part under its own id, so a
surface can stack them and the user can answer them one by one.

The terminal part SHALL carry `reply`, the kind of the reply that the ledger row
recorded:

- A `resolved` ask carries `once` or `always`. A ledger reply that is not one of
  the two gives `once`, the same narrowing that the approval of `ctx.ask` uses.
- A `rejected` ask carries `reject`.
- A `pending`, `aborted`, or `expired` part carries no `reply`.

The part SHALL NOT carry the feedback of a rejection, because that text is for the
model.

#### Scenario: The pending part names the exact command

- **WHEN** `ctx.ask` pauses on a request
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

- **GIVEN** two tools pausing on asks in the same turn
- **WHEN** the parts are emitted
- **THEN** each ask is a distinct part under its own id, answerable independently
