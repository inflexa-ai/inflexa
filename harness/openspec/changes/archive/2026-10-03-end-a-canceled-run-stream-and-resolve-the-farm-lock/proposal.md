## Why

The local server of the CLI serves many analyses from one process, and it streams each run through the run-event reader of the harness. The reader had three gaps for such a host:

- A canceled run ended its stream with no terminal part. The canceler cannot write the part, because `DBOS.writeStream` works only in a workflow body. Thus each host made the part on the read side, as Cortex does with its own poll.
- `subscribe` settled while parts stayed in its queue. A slow handler lost the parts that it did not take before the settle.
- `farmLockFile` was one static path. A host that keeps one farm for each analysis gave each analysis the package inventory of the boot analysis.

## What Changes

- The run-event reader ends a canceled run with a `data-run-failed` part whose `reason` is `canceled`. It reads the run row when the streams end with no terminal part.
- `subscribe` settles only after the handler takes the last part.
- `farmLockFile` also accepts a function of the analysis id. Each reader of the inventory resolves the path with the analysis id of its session.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-event-stream`: the subscription settles after the handler takes the last part, and a canceled run ends with a terminal part.
- `package-store`: the embedder can bind the farm lock path for each analysis.

## Impact

- `harness/src/execution/run-event-stream.ts`, `harness/src/contracts/chat-parts.ts`, `harness/src/execution/run-canceler.ts` (comment only).
- `harness/src/config/environment-stores.ts`, `harness/src/tools/sandbox/list-available-packages.ts`, `harness/src/tools/execute-analysis.ts`.
- A host that gives a string for `farmLockFile` sees no change. Cortex can replace its own canceled-part poll with the reader.
