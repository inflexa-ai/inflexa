# Spec Delta

## REMOVED Requirements

### Requirement: Conversation guidance treats synthesis as present only when produced

**Reason**: The requirement pinned the wording of the conversation prompt and of the `inspect_run` description. Prompt text is not a spec contract.

**Migration**: None. The `inspect_run` result still gives `synthesisPath` only for a produced synthesis, and the prompt names the step summaries as the fallback.
