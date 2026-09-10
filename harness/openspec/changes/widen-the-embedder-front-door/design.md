## Context

`harness/src/index.ts` is the curated front door. It carries the names that an
embedder faces, and each deep subpath stays importable for internal wiring. A
second embedder now exists: the bench (`inflexa-ai/bench`). Its rule is an
import from the package root only. Three names that it needs are absent from the
root today, thus it holds three deep imports as debt.

The barrel already states its own rule in its comments: a name belongs on the
front door when an embedder cannot type its own composition root without that
name. Items 1 and 2 of this change are two applications of that one rule. Item 3
is new behavior, thus it is a capability of its own.

`workflows/target-assessment/progress.ts` writes one durable stream under the
key `progress`. The workflow id of a target assessment is the assessment id, and
the workflow has no child that writes this stream. Thus one assessment has one
progress stream.

`execution/run-event-stream.ts` is the precedent for a reader that quarantines
the durability engine. It is a push subscription, it takes an abort signal, and
it contains each failure. `index.ts:661` exports it.

## Goals / Non-Goals

**Goals:**

- An embedder types its `ConversationAgentDeps` with names from the root only.
- An embedder reads and writes the target-assessment rows with names from the
  root only, and it names each value that a read gives back.
- An embedder observes the progress of a target assessment, and it imports no
  type of the durability engine to do it.
- Each document of the harness names code that exists.

**Non-Goals:**

- No new tool, no new workflow, and no change to the behavior of an existing
  one.
- No export of the internal writers of the target-assessment terminal path
  (`setDossier`, `markFailed`, `markAssessmentSuspended`,
  `markAssessmentRunning`, `softDeleteAssessment`). The workflow owns them.
- No general-purpose reader of a durable stream. Such a reader carries the model
  of the engine back into the surface that these seams remove.
- No transport. The harness gives a subscription, and an embedder builds the
  route.

## Decisions

### One capability for the front door, not a scenario in each owning spec

Three specs state an export requirement inside the capability that owns the name
(`thread-agent-resolution:37`, `docker-sandbox-provider:228`,
`structured-logging:190`). That precedent has no home for the two families here.
`BioToolKeys` spans the literature, the drug, the disease, and the chemistry
sources, thus `literature-search` owns a part of it only. The target-assessment
rows have no capability at all: `postgres-storage-backend:10` names the table
and nothing more.

Thus this change makes one capability, `harness-embedder-exports`. It states the
rule that decides a name, and it holds the two families. A future export request
lands in one place, and a reader of the front door reads one document.

**Alternative, and why not:** a scenario in `literature-search` and a second in
`postgres-storage-backend`. Rejected, because `postgres-storage-backend` is
about the pool, the DDL, and the isolation of the two databases. An export rule
there has no relation to its purpose.

### The reader is a push subscription, not an async iterable

`createTargetAssessmentProgressStream` gives one method, `subscribe`. It takes
the assessment id, a handler, and an abort signal, and it gives a promise. The
promise settles when the workflow is terminal and the stream drains, or when the
signal aborts.

The read primitive of the engine is an async generator. To give that generator
back to a caller puts the model of the engine on the surface. This seam exists
to remove that model. A generator also leaves no place to contain a failure. A
handler gives both: the callback matches the `EmitFn` idiom of the writers, and
the seam owns the `try`/`catch` around each delivery.

**Alternative, and why not:** an `AsyncIterable<TargetAssessmentProgressEvent>`.
Rejected for the two reasons above.

### The delivered value is the event, not the envelope of the writer

`emitProgress` writes a `ProgressPart`, the object
`{ type: "data-target-assessment-progress", payload }`. That type key is not in
the chat-part registry (`contracts/chat-parts.ts`). Thus it is a private
envelope of the writer, not public vocabulary.

The reader parses each stream value with `TargetAssessmentProgressEventSchema`
and delivers the `payload` as a `TargetAssessmentProgressEvent`. A value that
does not parse is logged and dropped. Thus the caller gets the contract type,
and the envelope stays private.

### The reader does not fold by phase

The workflow body emits each phase one time. The engine caches the write offset
of a step. Thus a recovered workflow does not write a phase again. A fold by
phase is a no-op against this writer. The reader delivers each event one time,
in write order, and it holds no buffer.

`run-event-stream` folds because its parts reconcile by id and a mid-run
subscriber replays a long history of superseded values. The progress stream has
neither property.

### The reader takes no database pool

`run-event-stream` takes a `Pool`, because it discovers the child workflows of a
run from the step ledger. A target assessment writes progress from the parent
body only. Thus the reader opens one stream, under the assessment id, and it
needs no pool. Its one dependency is the optional `Logger`, which defaults to
silence.

### The reader lives beside the writer

The new module is `src/workflows/target-assessment/progress-stream.ts`. The
stream key `TA_PROGRESS_STREAM_KEY` then stays private to the writer and the
reader, and no third module names the string.

### The two spec repairs are delta specs, and `CONTEXT.md` is a task

`harness-durable-runtime` and `agent-skill-assignment` each hold a requirement
that names code that does not exist. A change to a spec goes through a delta
spec of this change. `CONTEXT.md` is a document, not a spec, thus its repair is
a task.

## Risks / Trade-offs

- **The reader needs a live durability engine for a test** → The repository
  already has a DBOS suite (`src/workflows/__tests__/dbos/`).
  `target-assessment-internals.test.ts:297` already reads this exact stream.
  The new test goes beside it.
- **A new capability spec adds to a corpus of 94 specs** → The one capability
  replaces the scatter of an export rule across three unrelated specs. It gives
  each future export request one home. The count grows by one, and the cost of
  a read falls.
- **An exported `updateProgress` lets an embedder write the progress column out
  of band** → The same is already true of `upsertAnalysis` and `updateRunStatus`
  on the barrel. The column is a display value, and the workflow overwrites it
  at the next phase.
- **A stream value that does not parse is dropped** → A drop is logged at debug,
  the same as `run-event-stream:191`. The alternative is a failed subscription,
  which is worse: observation must never be more fragile than the writer that
  it observes.
