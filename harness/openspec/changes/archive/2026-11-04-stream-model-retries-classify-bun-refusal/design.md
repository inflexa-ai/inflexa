# Design

## Context

See proposal.md, "Why", for the two defects.

The retry part. The retry envelope of the provider runs inside the step of the model call. The durable model middleware of `@dbos-inc/vercel-ai` wraps the whole `doStream`, with the envelope in it, in `DBOS.runStep`. The envelope calls `onRetry`, and the loop then calls the emit of the turn (`loop/run-loop.ts`, the `onRetry` of `runSeries`).

The emit of `createTurnStreamWriter` (`loop/chat-stream.ts`) sends each frame from a step to `toolWriter()` of the library. Only a tool step that `durableTools` wraps has that writer. A model step does not have it, thus `toolWriter()` throws, and the `catch` of `onRetry` discards the failure.

A transient frame of a tool step already reaches the durable stream. The library `StepWriter` gives a transient chunk to the `writer` of `durableTools`, which is the `toolWriter` of the turn stream writer (`loop/tool-adapter.ts`). That writer writes each chunk with `writeDurableStream` from inside the step. `durableTools` gets no `durableStream` option, thus the chunk is written one time.

The connection check. The classification walks the `cause` chain and compares each code with `CONNECTION_ERROR_CODES` (`providers/errors.ts`). These measurements come from Bun 1.4.2 and the AI SDK of the harness:

| Failure | The error that the classification gets |
| --- | --- |
| A refused connection | `AI_APICallError`, message "Cannot connect to API: Unable to connect. Is the computer able to access the url?", no status. Its cause is a `TypeError` with the code `ConnectionRefused`. |
| A reset, before or during the response | `TypeError`, code `ECONNRESET`, message "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()" |
| A host with no DNS record | `TypeError`, code `ENOTFOUND` |

Only `ConnectionRefused` is not in the list.

## Goals / Non-Goals

**Goals:**

- Each reader of a turn gets each retry part of the root agent.
- A refused connection under Bun pauses the turn as an outage.

**Non-Goals:**

- A change to the reader of the stream. The probes of issue #823 found no stop of the first reader.
- A change to the `cli`. Its fold already shows a retry part in the header, and it clears the status at the next frame of the turn.
- A match on the message text of Bun. The code is a stronger signal, and the cause walk reaches it.

## Decisions

### D1: The turn writes the retry part to its durable stream

The part goes to the durable stream of the workflow, from inside the model step. Each reader then gets it live or from the history of the stream. A later reader folds the earlier parts by the request id, thus it shows the newest retry.

Alternatives:

- A live channel in the memory of the process, to each open reader. Rejected. A reader in a different process does not get it, and a later reader gets nothing until the next retry. It also adds a second transport beside the stream.
- A write from the workflow body. Rejected. The envelope runs inside the step, and a body write takes a checkpoint id, which a step cannot take.

### D2: A transient frame of a step goes to the turn stream writer directly

In a step, the emit sends a frame whose chunk is transient to the `toolWriter` of the turn stream writer. It does not call `toolWriter()` of the library for it. A frame that is not transient keeps the library writer, because the library checkpoints that frame with its tool step.

For a tool step, the result does not change, because the library `StepWriter` gives a transient chunk to the same writer. For a model step, the write now occurs, and the emit does not throw.

The sub-agent workflow builds its writer with the same `createTurnStreamWriter` (`loop/sub-agent.ts`). As a result, the retries of a sub-agent also go to the stream of the sub-agent, and the reader of the turn merges them. No test of this change pins that result.

Alternative: catch the throw of `toolWriter()` and write the frame in the `catch`. Rejected. That is a `catch` for control flow, and the harness catches an exception only at a boundary.

### D3: No `DBOS.patch` is necessary

A write from a step takes no function id of the workflow (`chainBodyWrites` calls the write directly in a step). Thus the operations of a workflow body do not change, and a paused workflow replays its checkpoints with no change.

### D4: The code list gets the Bun code for a refused connection

`CONNECTION_ERROR_CODES` gets `ConnectionRefused`. The comment of the list names Bun with Node and undici. Bun gives `ECONNRESET` for a reset, which the list holds already. A test of each measured shape pins the result.

### D5: The comment of `chunkOfFrame` states what a transient chunk is

The comment says that a transient chunk is live only. That is not correct, because the chunk is in the durable stream. The comment must say that a replay of the step does not write the chunk again, and that the stored transcript does not hold it.

## Risks / Trade-offs

- [More rows in the stream table] → A request writes one small row for each retry, and the default envelope limits the retries to 10. The purge of an analysis deletes the stream with its workflow.
- [The next text comes before the retry part] → The envelope calls `onRetry` before its wait, and the write of the part starts then. The text of the next attempt waits for a provider response and for the 25 ms batch of the model writer. A database insert slower than that can put the part after the text. No order is promised, and the fold of the `cli` then clears the status at the next text frame.
- [A reader of an ended turn gets old retry parts] → Each later frame of the turn follows the parts. The fold of the `cli` clears the retry status at the next frame.
- [A write of the step and a write of the model text take the same offset] → DBOS writes the loser again at the next offset.
- [A recovery runs the model step again] → The new attempt writes its parts with a new request id. The fold shows the newest part.

## Test notes

- A test of the stream drives the real envelope with `scriptedModel(steps, { maxRetries })`, as `loop/test/run-loop.test.ts` does. Without a named delay, the envelope waits a random delay of up to 2 s, then up to 4 s. An `APICallError` with the status `503` and the response header `retry-after-ms` sets the wait (`serverNamedDelayMs` in `providers/ai-sdk.ts`).
- The test holds each attempt of the scripted model on a promise, as task 2.1 tells. Thus each reader is open before the part that it must get live, and the test does not depend on the delays of the envelope.
- The tests of the classification use the measured shapes of the table above, with the real `APICallError` of `@ai-sdk/provider` for the refused connection.
