# Spec Delta

## REMOVED Requirements

### Requirement: Artifact-sourced data goes through dataPath, not inline rows

**Reason**: The requirement pinned an agent obligation that only the wording of the `show_user` description carries. A tool description is not a spec contract.

**Migration**: None. `show_user` still loads a CSV path in `dataPath` at render time, and its description sends data that is not chart-ready to `run_script` and `write_derived`.
