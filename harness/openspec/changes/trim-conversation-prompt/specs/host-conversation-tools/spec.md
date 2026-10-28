# Spec Delta

## REMOVED Requirements

### Requirement: The conversation prompt orients the agent to host input tools for unstaged data

**Reason**: The requirement pinned the wording of the conversation prompt. Prompt text is not a spec contract.

**Migration**: None. The approval hook of a host input tool still asks the user, and the decision evals cover the add of an input (`add-inputs-from-launch-dir`, `no-invented-input`).
