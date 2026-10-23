## MODIFIED Requirements

### Requirement: The loop reports each compaction as a data part

The loop MUST emit the progress of each compaction through its `emit`, as a `data-compaction` part with the source of the run. The part carries these fields:

- `id`: one id for each compaction
- `status`: `running`, then `done` or `failed`
- `trigger`: `turn-start` or `mid-turn`
- `tokensBefore`: the input tokens of the last request before the compaction
- `durationMs`: the time of the compaction, on a terminal status

The loop MUST emit `running` before the exchange. It MUST emit one terminal status under the same id: `done` after a summary marker, or `failed` when the view did not change. The view does not change after an exchange with no summary, an abort, or a throw out of the exchange. A throw then passes through the loop.

The loop MUST emit `done` before it gives the round sink the round of the marker. A chat turn gives the rounds after a marker a new assistant message. Thus the `running` part and the `done` part of one compaction stream into the same message.

The loop MUST NOT emit `tokensAfter`. No figure of the new view exists before the next request. The field stays optional in `CompactionPart` only for a part that an older harness stored.

The part registry MUST list `data-compaction` with the emitter `conversation`, the consumer `conversation`, `transient: true`, and `reconciling: true`. The display recorder does not store a transient part. The stored marker carries the divider (see the harness-thread-history capability).

The loop MUST log each compaction through its `Logger`: at `info` for a summary, and at `error` for an exchange with no summary. The record carries the id, the trigger, `tokensBefore`, and the duration. A record for a refusal also carries the HTTP status and the error text of the provider.

#### Scenario: A summary emits running and then done

- **GIVEN** a run that compacts one time with a summary
- **WHEN** the run returns
- **THEN** the `emit` got one `data-compaction` part with `running` and `tokensBefore`, and then one with `done` and `durationMs`, under the same id
- **AND** no part carries `tokensAfter`

#### Scenario: The done part comes before the round of the marker

- **GIVEN** a run with a round sink that compacts one time with a summary
- **WHEN** the run returns
- **THEN** the `emit` got the `done` part before the round sink got the marker and its records

#### Scenario: An exchange with no summary emits failed

- **GIVEN** a run whose exchange gives no summary
- **WHEN** the exchange ends
- **THEN** the terminal part carries `failed` and `durationMs`, and no `tokensAfter`

#### Scenario: An abort emits failed

- **GIVEN** a run whose signal aborts during the exchange
- **WHEN** the run returns
- **THEN** the terminal part carries `failed`, and the transcript holds no new marker

#### Scenario: The part and the log name the trigger

- **GIVEN** a run that does a turn-start compaction with a summary
- **WHEN** the run returns
- **THEN** each `data-compaction` part of the compaction carries the trigger `turn-start`
- **AND** the `info` record of the compaction carries the same trigger

#### Scenario: The part carries the source of the run

- **GIVEN** a root loop with the call path `["tui-chat"]`
- **WHEN** the loop emits a `data-compaction` part
- **THEN** the source of the part carries the call path of the run, not the call path of the exchange

#### Scenario: The registry lists the part

- **WHEN** a reader reads `PART_REGISTRY["data-compaction"]`
- **THEN** it gives the emitter `conversation`, the consumer `conversation`, `transient: true`, and `reconciling: true`
