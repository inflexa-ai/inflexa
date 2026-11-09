# Design

## Context

The `chat-turn.prepare` step of `runTurnWorkflow` returns `model: thread?.model ?? null`. A turn that started on harness 0.48.5 or earlier recorded the step without that key. JSON has no `undefined`, thus the replayed `opening.model` is `undefined`, but its type is `string | null`. `providerOfThread` keeps the provider of the host only for `null`.

## Goals / Non-Goals

**Goals:**

- A turn that replays an old prepare result runs on the provider of the host.

**Non-Goals:**

- A `DBOS.patch`. The operations of the body do not change, only the shape of one step result.
- A different read of the thread on replay. The spec requires that a replay uses the recorded value.

## Decisions

- **Read `opening.model ?? null` where the workflow reads the replayed result.** The replayed result enters the workflow at this point. After this point, the type `string | null` is true. A `model == null` test in `providerOfThread` gives the same behavior, but the false type then goes on to each later reader.
- **Do a test of a real replay.** The test crashes a turn after its prepare step, and it removes `model` from the stored output of the step in `dbos.operation_outputs`. Then the recovery replays that output. A unit test with a cast does not do a test of the replay.

## Risks / Trade-offs

- [The test edits a DBOS table directly] → The test reads the stored output first and removes only the `model` key. Thus a change of the DBOS serialization makes the test fail visibly, and it does not pass for a different reason.
