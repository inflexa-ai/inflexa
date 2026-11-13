# Proposal

## Why

In the run of analysis GSE136961, the report step got the upstream summaries only. Its report held the template ids and the snapshot digest, and no rule, no method id, and no DOI. The synthesis cited only the PubMed ids of its lookups. The pinned citations of a report session came from those PubMed ids only, thus a DOI citation block never resolved.

## What Changes

- The handoff of each completed dependency carries the methods of that dependency and the paths of its decision records. The briefing renders a bounded list of the grounding, the templates, the rules, and the sources.
- A shared reader gives the methods of the steps of a run from the stored plan and the decision records on disk.
- The synthesis gets the optional `methodReferences` field. `submit_synthesis` checks each reference against the method sources of its step, and not against a lookup. The seed of the synthesizer lists the method sources.
- The pin of a report session collects the method sources of each run and the method references of each synthesis.
- A DOI citation key is in lower case. The pin, the resolver, and the renderer make the key with one function.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the briefing gives the methods of each upstream step.
- `run-synthesizer`: `submit_synthesis` checks a method reference against the methods of the run.
- `report-snapshot`: the pin collects the method sources, and a DOI citation key is in lower case.

## Impact

- `src/execution/run-methods.ts` is new. `src/execution/step-methods.ts`, `src/execution/run-synthesis.ts`, `src/app/synthesize-run.ts`, `src/report-model/pin-snapshot.ts`, `src/report-model/reference-read.ts`, `src/report-render/references.ts`, `src/contracts/report-reference.ts`, `src/prompts/briefing.ts`, `src/prompts/synthesis-agent.ts`, `src/schemas/run-synthesis.ts`, and `src/workflows/execute-analysis.ts` change.
- The methods of a dependency are read inside the checkpointed step of the seed. The methods of the synthesis are read inside the checkpointed step of the summaries. Thus no workflow body changes its sequence of steps, and no `DBOS.patch` is necessary.
- A checkpoint of the summaries that an older version wrote has no methods, and the synthesis then has no method source.
- The pin can fail with the new kind `plan-read-failed`.
