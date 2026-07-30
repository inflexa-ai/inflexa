## ADDED Requirements

### Requirement: A refresh that cannot complete SHALL NOT disable future refreshes

The in-flight guard that makes the poll skip a tick while a refresh is running SHALL always be
released, including when that refresh never completes normally. A refresh SHALL therefore be
bounded, and its guard released, whether it succeeds, fails, or exceeds its bound.

This is the failure mode the existing skip rule creates and does not close. The guard is claimed
before the reads and released on their completion, so a read that never settles leaves it claimed
for the lifetime of the process. That does not merely stall one tick: it disables the bounded poll
**and** every event-triggered refresh at once, because both consult the same guard. Every live
surface then freezes at its last value with no error anywhere, which is indistinguishable from a
run that has stopped progressing.

The bound SHALL be comfortably longer than the poll interval — long enough that a merely slow
refresh completes and writes its snapshots, which the existing cadence requirement already
promises, and short enough that a wedged one is released within a small number of ticks. It is
expressed as a multiple of the poll interval rather than an independent constant, so the two
cannot drift apart when either is tuned.

A refresh abandoned at its bound SHALL leave the previous snapshots in place rather than writing a
partial or empty one, and SHALL be reported so the condition is diagnosable rather than silent.

#### Scenario: A refresh that never settles is abandoned and the guard released

- **GIVEN** a refresh whose reads do not settle
- **WHEN** its bound elapses
- **THEN** the refresh is abandoned, the in-flight guard is released, and a subsequent tick or lifecycle edge starts a new refresh

#### Scenario: One stalled refresh does not freeze every surface

- **GIVEN** a refresh has been abandoned at its bound
- **WHEN** the next poll tick fires
- **THEN** it proceeds rather than being skipped, and the sidebar and activity panel resume updating

#### Scenario: An abandoned refresh preserves the last good snapshots

- **WHEN** a refresh is abandoned at its bound
- **THEN** the previously published snapshots remain, and no empty or partial snapshot is written in their place
