# Spec Delta

## ADDED Requirements

### Requirement: The scratch of a conversation lives under one named directory

The scripts of a conversation and the files that they derive MUST live at `{workspaceRoot}/conversation-sessions/{threadId}/`: the scripts under `scripts/`, and the derived files under `derived/`. A script MUST write only into `derived/` of its own conversation. Thus a script cannot replace an input, a run output, or a file of a different session.

#### Scenario: A derived file lands in the scratch of its conversation

- **WHEN** a script of thread `t-1` writes `top.csv`
- **THEN** the file is at `conversation-sessions/t-1/derived/top.csv`
