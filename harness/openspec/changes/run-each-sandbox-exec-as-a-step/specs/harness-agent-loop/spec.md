## ADDED Requirements

### Requirement: Tool dispatch runs step calls in parallel and folds the call records

Within one turn, the AI SDK loop integration MUST dispatch each tool call by the
execution mode of its tool. `step` tools MUST be wrapped as deterministic durable
steps, and they can run concurrently where AI SDK lets parallel tool calls occur.
A sandbox tool is a `step` tool, and its exec runs inside its tool step. `inline`
tools MUST run after the step tools, one at a time, with no step. Results MUST be
associated with the original tool-call ids.

After the whole round settles, the loop MUST give the call record of each call
to the `foldCallRecord` of its tool (see the harness-tools spec). It MUST fold
in the order of the tool calls. The parallel step calls settle in any order. Thus the fold
waits for the round, and a replay folds the same records in the same order. The
loop MUST fold on the first run and on each replay alike. A refused call, a
failed call, and an ok value with no record MUST reach no fold.

#### Scenario: Sandbox tools of one round run in parallel

- **GIVEN** a turn whose tool calls include two `execute_command` calls
- **WHEN** the loop dispatches them
- **THEN** each call runs as its own durable step, and the two steps run at the same time

#### Scenario: Step-backed tools cache through deterministic steps

- **GIVEN** a turn whose tool calls include external lookup tools
- **WHEN** the loop dispatches them
- **THEN** each lookup runs through a deterministic `runStep` wrapper and can cache-hit on DBOS replay

#### Scenario: Call records fold in call order

- **GIVEN** a round of two step calls `A` and `B` that carry records, where `B` settles first
- **WHEN** the round settles
- **THEN** the loop folds the record of `A`, and then the record of `B`

#### Scenario: A replayed round folds its records again

- **GIVEN** a round whose step calls completed, and a workflow that recovers in a new process
- **WHEN** the loop replays the round from the step cache
- **THEN** the loop folds the cached records in call order, and no tool runs `execute` again

## MODIFIED Requirements

### Requirement: The loop wraps tool failures as error tool results

When a tool execution returns `err(ToolError)`, throws, or receives invalid
input, the AI SDK tool wrapper MUST return an error tool result. The model can
read that result and recover from it. A fatal loop error that the injected fatal
predicate matches MUST propagate out of the loop, and it MUST NOT become a
model-visible tool result. The cancel of a sandbox exec inside a step tool is
one example.

#### Scenario: A throwing tool becomes an error tool result

- **GIVEN** a tool whose execution throws
- **WHEN** the AI SDK loop dispatches it
- **THEN** the corresponding tool result is marked as an error and the loop can continue

#### Scenario: A fatal loop error is re-raised, not swallowed

- **GIVEN** a step tool whose execution throws an error that `isFatalLoopError` matches, for example the `DBOSWorkflowCancelledError` of a canceled sandbox exec
- **WHEN** the loop dispatches it
- **THEN** the error propagates out of the loop instead of becoming a model-visible tool result

#### Scenario: Invalid tool input is rejected before execute runs

- **GIVEN** a tool call whose input fails the tool's Zod schema
- **WHEN** the tool wrapper validates it
- **THEN** the tool implementation is never called and the model receives an error tool result

### Requirement: The tool-finished observation reports the call's own elapsed time

The loop's `tool-finished` event MUST carry `durationMs`, the time elapsed around
that call's own dispatch. The loop MUST measure each call individually, around
the same unit it awaits for that call: the durable step wrapper for a step-mode
tool, and the dispatch itself for an inline-mode tool.

The field MUST be OPTIONAL, and it MUST be absent rather than zero when no
measurement was taken. A host MUST be free to use its own measurement when the
field is absent, thus a consumer built against an earlier harness keeps working.

The loop emits each `tool-started` for a round before it dispatches anything and
each `tool-finished` after the round settles. That order is deliberate: it lets a
host show the whole round's calls at once, which is an honest preview of what the
model asked for. But a host that measures between the two events measures the
round and not the call. Each call in a round then reports the same figure. When
each call has its own description, that figure is a false claim about each one.

The measure inside the loop makes the order and the timing both correct. The
alternative is to emit the events of each call around its own dispatch. Then
the chips of the round would appear one at a time for the inline mode.

Both dispatch paths MUST report timing through the same path, thus a truncated
round and a normal one cannot disagree.

#### Scenario: Concurrent calls in one round report their own durations

- **GIVEN** a dispatch round of some step-mode tool calls, one of which takes substantially longer than the others
- **WHEN** the loop emits their finished events
- **THEN** each event carries that call's own elapsed time, and the faster calls do not report the slower call's figure

#### Scenario: A sequentially dispatched call is not charged for its predecessors

- **GIVEN** a dispatch round of some inline-mode tool calls, which dispatch one after another
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

## REMOVED Requirements

### Requirement: Tool dispatch is partitioned by durability ownership

**Reason**: The `workflow` mode is removed. Each sandbox tool runs as a step tool, and the loop folds the call records after each round.

**Migration**: Refer to "Tool dispatch runs step calls in parallel and folds the call records".
