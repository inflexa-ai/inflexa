# Spec Delta

## MODIFIED Requirements

### Requirement: Conversation guidance treats synthesis as present only when produced

The `inspect_run` description MUST say that `synthesisPath` appears only when `synthesisStatus` is `produced`. The section "Interpreting Results" of the conversation prompt MUST name the `synthesisStatus` and the `synthesisPath` that `inspect_run` gives. It MUST tell the agent to integrate the per-step summaries itself when the run has no synthesis. It MUST NOT present `synthesis.json` as an unconditional primary source for each completed run.

#### Scenario: Guidance directs a fallback on a skipped synthesis

- **WHEN** the conversation prompt and the `inspect_run` description are composed
- **THEN** the description gives `synthesisPath` only for a run whose synthesis was produced
- **AND** the prompt names the step summaries as the fallback when the run has no synthesis
