## MODIFIED Requirements

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
