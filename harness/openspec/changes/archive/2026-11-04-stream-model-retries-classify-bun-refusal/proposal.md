# Proposal

## Why

A client never gets a `data-model-retry` part, thus it cannot show the retries of a model request (issue #824). The loop emits the part from inside the step of the model call. There, the emit goes to the tool writer of the library, which a model step does not have. Thus the emit throws, and the loop discards the failure.

A turn fails at once when Bun refuses the connection to the model endpoint (issue #825). Bun gives the fetch code `ConnectionRefused`, and the connection check does not know it. Thus the failure is not retryable, and the turn does not pause with the cause `outage`.

Issue #823 reported that the first reader of a turn stops before the `data-pause` part. A reader that opens at the start of a turn gets the part live in each probe with the real provider. The gap in the report was the retry envelope, which gave no visible part because of #824. Thus this change has no work for #823.

## What Changes

- The turn writes each `data-model-retry` part to the durable stream of its workflow, from the step of the model call. The part goes through the same harness writer that the transient frames of a tool step use.
- A reader that opens before or during the retries of a request gets each part that the turn writes while it reads. A reader that opens later also gets the parts before it. Thus its fold shows the newest retry of the request.
- The stored transcript still holds no `data-model-retry` part.
- The connection check knows the Bun fetch code `ConnectionRefused`. Thus a refused connection under Bun is a retryable `provider` failure, and the turn pauses with the cause `outage`.
- Tests pin the measured Bun shapes for a refused connection and for a reset connection.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-turn-stream`: the stream of a turn carries each retry of a model request, for each reader of the turn.
- `harness-providers`: the classification of a connection failure knows the fetch code of Bun for a refused connection.

## Impact

- `harness/src/loop/chat-stream.ts`: the emit of a transient frame from a step.
- `harness/src/providers/errors.ts`: the list of connection error codes.
- Tests in `harness/src/app/test/` and `harness/src/providers/test/`.
- No change to a public type or to an export. The `cli` consumes the parts with its existing fold, and it needs no change.
