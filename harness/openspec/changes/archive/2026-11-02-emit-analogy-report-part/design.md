# Design

## Context

`generate_analogy_report` sets `startsWorkflow: true`. Thus its `execute` runs in the body of the turn workflow, and the reasoner runs in a child workflow. A write to the stream from the body is checkpointed, thus a replay writes nothing again. `generate_plan` emits its `data-plan` part from the same place (`src/tools/research/generate-plan.ts`).

The display recorder keeps only the frames of the root agent. A part that the child emits never reaches the stored display.

## Goals / Non-Goals

**Goals:**

- One typed part that carries what the tool gave the model.
- The same part on a live stream and on a reload.

**Non-Goals:**

- A renderer. The cli change `render-analogy-report-block` adds it.
- A change of `AnalogicalReasonerOutputSchema` or of the reasoner.

## Decisions

- **Emit from `execute`, after the child returns.** The emit uses the session of the conversation agent. Thus the recorder keeps the part, and the checkpoint of the body prevents a second part on replay. A child emit would give a sub-agent frame, and the recorder drops such a frame.
- **The payload is `{ id, report }`, and `report` is the full `AnalogicalReasonerOutput`.** A host must show the error state, thus the part also carries the `extraction-failed` envelope. The zod arm uses `AnalogicalReasonerOutputSchema`, thus the contract has one source.
- **The id is the id of the tool call.** One call gives one part, and the id is stable on replay.
- **The registry entry is `conversation`, `conversation`, not transient, not reconciling.** The part is emitted one time and it is kept, the same as `data-report-rendered`.
- **The reply gives a summary.** The block shows the full report, thus a full copy in the reply shows the same text two times.

## Risks / Trade-offs

- [A report with many sources makes a large part] → The reasoner limits the analogies to 5 and the solutions to 5 for each analogy. The stored display does not enter the model history.
- [A host with no renderer sees an unknown part] → The cli adds the renderer in the same branch. A different host shows its unknown-part fallback.
