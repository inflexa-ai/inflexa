## ADDED Requirements

### Requirement: The tool-finished observation reports the call's own elapsed time

The loop's `tool-finished` event SHALL carry `durationMs`, the time elapsed around that call's own dispatch. The loop SHALL measure each call individually, bracketing the same unit it awaits for that call — the durable step wrapper for a step-mode tool, the dispatch itself for a workflow- or inline-mode tool.

The field SHALL be OPTIONAL, and SHALL be absent rather than zero when no measurement was taken. A host SHALL be free to fall back to its own measurement when the field is absent, so a consumer built against an earlier harness keeps working.

The loop emits every `tool-started` for a round before it dispatches anything and every `tool-finished` after the round settles. That ordering is deliberate — it lets a host show the whole round's calls at once, which is an honest preview of what the model asked for — but it means a host bracketing the two events measures the round rather than the call. Every call in a round then reports an identical figure, and once calls are individually described that figure reads as a distinct, false claim about each one. Measuring inside the loop is what makes the ordering and the timing both correct; the alternative, emitting each call's events around its own dispatch, would serialize the round's chips for the sequentially-dispatched execution modes.

Both dispatch paths SHALL report timing through the same path, so a truncated round and a normal one cannot disagree.

#### Scenario: Concurrent calls in one round report their own durations

- **GIVEN** a dispatch round of several step-mode tool calls, one of which takes substantially longer than the others
- **WHEN** the loop emits their finished events
- **THEN** each event carries that call's own elapsed time, and the faster calls do not report the slower call's figure

#### Scenario: A sequentially dispatched call is not charged for its predecessors

- **GIVEN** a dispatch round of several workflow-mode tool calls, which dispatch one after another
- **WHEN** the loop emits their finished events
- **THEN** each event reports only the time around its own dispatch, not the elapsed time since the round began

#### Scenario: A failed call still reports its duration

- **GIVEN** a tool whose execution throws a non-fatal error
- **WHEN** the loop emits that call's finished event
- **THEN** the event reports `outcome: "error"` and carries the elapsed time around the failed dispatch

#### Scenario: A host without the field falls back to its own measurement

- **GIVEN** a `tool-finished` event carrying no `durationMs`
- **WHEN** a host renders that call
- **THEN** it reports a duration derived from its own observation rather than none
