## ADDED Requirements

### Requirement: A tool chip's duration comes from the harness when the event reports one

The emit adapter SHALL take a tool call's duration from `tool-finished` when that event carries one, and SHALL fall back to its own observation — the elapsed time between receiving that call's started and finished events — when it does not.

The local observation SHALL be retained for the fallback and for pairing an unmatched finished event to its part. Its role narrows; it is not removed.

The adapter's own bracket cannot measure a call. The harness emits every `tool-started` for a dispatch round before it dispatches anything and every `tool-finished` after the round settles, so the interval between the two events is the round's, and every call in a multi-call round is observed with the same figure. That is invisible while chips are indistinguishable and becomes a false claim once each carries its own detail — three visibly different calls each asserting one duration. Only the harness can measure an individual call, so the reported figure SHALL be its measurement wherever it is available.

#### Scenario: Concurrent calls in one round report their own durations

- **GIVEN** a dispatch round of several tool calls whose finished events carry differing `durationMs` values
- **WHEN** the chips settle
- **THEN** each chip reports its own event's figure, and a fast call does not display a slow sibling's

#### Scenario: An event without a duration falls back to local observation

- **GIVEN** a `tool-finished` event carrying no `durationMs`
- **WHEN** the chip settles
- **THEN** it reports the elapsed time the adapter observed, rather than no duration

#### Scenario: An unpaired finished event still renders

- **GIVEN** a `tool-finished` event for which no started event was received
- **WHEN** the adapter handles it
- **THEN** a finished part is appended, carrying the event's duration when it has one and none otherwise
