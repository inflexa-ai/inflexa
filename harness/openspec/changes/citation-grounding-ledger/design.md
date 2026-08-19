# Design: citation-grounding-ledger

## Context

The run synthesizer emits `findings[].references[].pmid` through its `submit_synthesis` terminal tool (`src/execution/run-synthesis.ts:357`). The semantic validation tests only the numeric format (`run-synthesis.ts:184`). The prompt rule says that each PMID must come from a `literature_reviewer` response (`src/prompts/synthesis-agent.ts:148`). No code enforces that rule.

The reviewer tool runs an inner agent loop and returns its final text (`src/tools/research/literature-reviewer.ts:115`). The inner transcript holds the tool results of the reviewer, and those results carry the PMIDs from the bibliographic authorities. The transcript is in scope inside the tool `execute`, and the loop stores a tool result as a typed `tool-result` part (`src/loop/run-agent.ts:446`).

The analogical reasoner (`src/tools/research/generate-analogy-report.ts:194`) and the target-assessment critique (`src/workflows/execute-target-assessment.ts:537`) cite literature with no verification tool.

## Goals / Non-Goals

**Goals:**

- A model-written PMID in a synthesis finding is grounded in a tool result, and the gate is mechanical.
- The analogical reasoner and the target-assessment critique can call `resolve_citation`.

**Non-Goals:**

- No authority resolution inside the gate. The ledger entries already come from an authority.
- No gate on the prose report of the reviewer, on a step summary, or on a chat reply.
- No DOI or arXiv entries in the ledger. The synthesis references hold PMIDs only.
- No change to the sandbox agent metas.

## Decisions

### 1. A transcript ledger, not authority resolution, blocks at the gate

The gate accepts a PMID only when a prior tool result carried it. This is deterministic, synchronous, and free of network failure modes. The alternative was `resolveMany` at submit time. That proves existence, but it adds latency, rate limits, and an outage policy to a validation path. The ledger chain ends at PubMed itself, thus resolution adds no new proof.

### 2. The ledger collects from the inner tool results of the reviewer

`createLiteratureReviewerTool` gains an optional `citationLedger` dependency. After the inner `runAgent` returns, the tool extracts the PMIDs from the `tool-result` parts of the inner transcript. It records them into the ledger. The prose report is not a source, because the report is model text. A PMID that the reviewer invents thus stays out of the ledger, and the gate downstream rejects it.

### 3. Extraction is field-aware, with a contextual text pattern as the second source

The extractor walks a parsed tool-result value. It collects a value whose key is `pmid` (case-insensitive) and whose text fits the PMID format. In a plain string it collects only a `PMID: <digits>` contextual match, never a bare number. A bare-number rule would collect years and counts, and an over-full ledger weakens the gate. A missed identifier causes a rejection, and the loop recovers through re-delegation to the reviewer. The helper lives in `src/citations/ledger.ts` with the ledger factory.

### 4. The gate is a pure semantic check over closure state

`InnerToolContext` (`run-synthesis.ts:92`) gains the ledger. Two new checks join `semanticCheck`: one over `findings[].references[].pmid`, one over `keyReferences[].pmid`. A rejection names each ungrounded PMID and points the model at `literature_reviewer`. The checks stay synchronous, and the validate and submit tools keep their shape.

### 5. The reasoner and the critique get the voluntary tool, not a gate

Their outputs are prose and supplied-evidence citations, and the target-assessment validator already tests dossier self-consistency. A gate there is a larger design with its own submit protocol. This change adds `resolve_citation` to `reasonerTools` and to `critiqueTools`, plus the prompt teaching.

### 6. Wiring follows the existing dependency pattern

- `createGenerateAnalogyReportTool` gains `citationResolver` in its deps. The conversation agent has the resolver in scope (`src/agents/conversation-agent.ts:216`).
- `ExecuteTargetAssessmentDeps` gains `citationResolver`. `assembleCoreRuntime` passes the resolver that it already builds (`src/runtime/assemble.ts:283`), in the same way as `usageRecorder` (`assemble.ts:293`).

## Risks / Trade-offs

- [Under-extraction causes a spurious rejection] → The contextual pattern plus the field walk covers the pubmed and reviewer result shapes. The rejection message gives the recovery path, and the loop is re-callable.
- [A step-summary PMID is now rejected] → This is deliberate. The prompt already forbids it, and the reviewer path confirms such a PMID in one delegation.
- [The ledger trusts tool results] → An entry comes from an authority response, not from model text. `resolve_citation` stays available for a caller-supplied citation.
- [A larger synthesis prompt] → The synthesis prompt is a static constant, thus the prompt-cache prefix changes one time and stays stable.

## Migration Plan

No persisted shape changes. The change is additive, and a revert restores the old gate.
