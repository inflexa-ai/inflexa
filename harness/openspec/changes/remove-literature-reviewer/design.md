## Context

See proposal.md, "Why". The current state before the change:

- The synthesis of a run runs its loop in the body of the run workflow. Each model call and each tool call is a step of that workflow (`workflows/execute-analysis.ts`, `synthesizeFindings`).
- The synthesizer held `literature_reviewer`, which started a child workflow `sub-agent.literature-reviewer` for each call. The child gave back only its final text.
- `submit_synthesis` checked the shape of a PMID. It could not find a cited PMID in a lookup result, because no lookup result reached the synthesizer.
- A tool call inside a workflow is a step. A replay gives the output of the step from the cache, and the body of the tool does not run again (`tools/define-tool.ts`, `toolCallRecordKey`).

## Goals / Non-Goals

**Goals:**

- Each cited PMID comes from a lookup result of the same run, and `submit_synthesis` refuses each other PMID.
- The refusal gives the same verdict on the first run and on a replay.

**Non-Goals:**

- No check of the content of a reference. The check finds the PMID in a lookup result. It does not read if the paper supports the finding.
- No new lookup tool. The lookups are the bio-lookup tools that the reviewer held.
- No `DBOS.patch` path for the removed reviewer.

## Decisions

### The synthesizer holds the lookups

A lookup result reaches only the loop that called the lookup. A check of a cited PMID needs that result, thus the loop of the synthesizer must make the call. The reviewer gave back a prose report, and its lookup results stayed in its own transcript.

The runtime builds the lookups one time (`createSynthesisLookupTools`). They share the citation resolver of the runtime, thus a `resolve_citation` of the synthesizer shares the pacing and the cache of each other surface.

### The PMID set is a call record

`recordingPmids` wraps each lookup. Its ok value carries a call record with the PMIDs that it holds. The loop folds each record into the set after each round, on the first run and on each replay.

The alternative is a side effect of `execute` on a set in the closure. A replay gives the cached output and never runs `execute`, thus a recovered synthesis would refuse each PMID that it cited before the crash.

A lookup that keeps its own call record cannot take the PMID record, because a value carries one record. `recordingPmids` throws for such a lookup when the synthesis builds its tools. Thus the synthesis fails, and it does not lose the record of the lookup without a sign.

The record comes from the whole value. The loop can cut a long result to an excerpt, but it keeps the record. Thus a PMID past the excerpt also counts.

### A PMID in the echo of a request does not count

`pmidsIn` reads each `pmid` and `pmids` key at any depth. It skips the keys `input`, `normalized`, `supplied`, and `query`. `resolve_citation` gives back the citation that it was given, and a PMID there came from the model, not from a source.

### The check skips a value that is not numeric

The existing check refuses a PMID that is not numeric. The new check reads only a numeric PMID, thus each bad value gets one issue.

### The loop has 40 iterations and no tool budget

A delegation was one iteration of the synthesizer. Now each round of lookups is one iteration, and one round can hold many parallel calls. The cap goes from 25 to 40 for these rounds, the draft, and the submit and fix cycles. The budget of the reviewer has no subject, thus it goes.

## Risks / Trade-offs

- [A synthesis in flight at the upgrade can fail its recovery] → No mitigation in the code. A run can be in its synthesis stage, with a reviewer child workflow that started already. The operations of the body changed, and the reviewer workflow is no longer registered. The user decided to remove the reviewer, and not to keep it behind `DBOS.patch`.
- [A correct PMID from the memory of the model is refused] → The issue tells the model to look it up or remove it.
- [Each lookup result goes into the synthesizer transcript] → The loop cuts a long result to an excerpt. `read_tool_output` reads the rest when the composition has a store.

## Migration Plan

No data migration. A stored `synthesis.json` keeps its shape. A `data-synthesis-progress` part that an older harness wrote still parses, and the schema drops its `delegationCount`.
