# Proposal: citation-grounding-ledger

## Why

The run synthesizer writes `findings[].references[].pmid` into durable, indexed findings. The only guard on those identifiers is a prompt rule plus a format validation (`src/execution/run-synthesis.ts:184`). Thus a model-invented PMID that fits the format persists as evidence. The analogical reasoner and the target-assessment critique also write citations with no verification tool at all.

## What Changes

- Add a citation ledger: a loop-scoped record of each bibliographic identifier that a tool result carried.
- The literature-reviewer tool records the identifiers from its inner tool results into the ledger of its caller. Its prose report is not a ledger source, thus an identifier that the reviewer invents does not enter the ledger.
- The `validate_synthesis` and `submit_synthesis` tools reject a finding reference or a key reference whose PMID is not in the ledger. The rejection names each ungrounded PMID, and the loop continues.
- Add the `resolve_citation` tool to the analogical reasoner and to the target-assessment critique agent. Plumb the `CitationResolver` into the target-assessment workflow dependencies for this.
- Extend the synthesis-agent prompt and the critique prompt with the new mechanism.

The gate is deterministic and local. It makes no network call, because each ledger entry already comes from a bibliographic authority through a tool result.

## Capabilities

### New Capabilities

- `citation-grounding`: the ledger primitive, its extraction rules, and the grounding gate of the run synthesizer. It also gives `resolve_citation` to the analogical reasoner and to the target-assessment critique.

### Modified Capabilities

- `literature-reviewer`: the semantic validation of `submit_synthesis` gains a grounding rejection, and the reviewer tool contract gains the ledger contribution from its inner transcript.

## Impact

- `src/execution/run-synthesis.ts`: the ledger closure state and the new semantic checks.
- `src/tools/research/literature-reviewer.ts`: the ledger contribution from the inner transcript.
- `src/citations/`: the identifier extraction helper.
- `src/tools/research/generate-analogy-report.ts`: `resolve_citation` in the reasoner tool set.
- `src/workflows/execute-target-assessment.ts` and `src/workflows/target-assessment/investigation/index.ts`: the resolver dependency and the critique tool set.
- `src/prompts/synthesis-agent.ts`, `src/prompts/analogical-reasoner.ts`, and the critique prompt: teach the mechanism.
- No breaking change to a public export. The `literature-reviewer` tool signature gains an optional ledger dependency.
