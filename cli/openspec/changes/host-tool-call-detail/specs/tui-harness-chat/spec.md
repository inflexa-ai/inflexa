## ADDED Requirements

### Requirement: A tool chip's duration comes from the harness when the event reports one

The emit adapter SHALL take a tool call's duration from `tool-finished` when that event carries one, and SHALL fall back to its own observation — the elapsed time between receiving that call's started and finished events — when it does not.

The local observation SHALL be retained for the fallback and for pairing an unmatched finished event to its part. Its role narrows; it is not removed.

The reported figure SHALL be the harness figure whenever the event carries one, and zero is such a figure. A sub-millisecond call reports a real `0`. Thus the fallback SHALL be a null-coalescing test and not a truthiness test.

A chip whose call never reported a duration SHALL display none. It SHALL NOT substitute an elapsed time that the adapter observed across a whole round. This governs the interrupted turn: a call still open when the turn ends receives no `tool-finished`, so nothing measured it. The adapter receives every start of a round together, so the time since a start stamp is the round's. A multi-call round would then strand some chips, each with one identical figure. That is the false claim this requirement removes.

The duration is live-only. The persisted conversation display records a call's outcome and detail and carries no duration field, so a replayed turn SHALL render its chips without one. A reader therefore cannot distinguish an unmeasured call from an unpersisted one, which is accepted: the duration is a diagnostic of the live turn, and reconstructing history is out of scope.

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
