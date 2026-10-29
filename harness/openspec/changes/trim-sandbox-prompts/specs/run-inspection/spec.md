# Spec Delta

## REMOVED Requirements

### Requirement: A workflow cannot wait for its own terminal state

**Reason**: No agent that runs under a `RunSession` holds `inspect_run`. The sandbox agents lost the tool, and the conversation agent runs in a chat turn, not in a run. The guard had no caller.

**Migration**: None. A wait on a running run polls until the run ends or the cutoff comes.
