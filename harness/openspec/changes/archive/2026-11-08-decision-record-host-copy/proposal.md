# Proposal

## Why

In the run of analysis GSE136961, `knowledge_template` wrote each decision record to `output/` of the step. The agent of step T1S1 ran `rm -rf output/* figures/* logs/*`, and then it ran its scripts again. `reconcileScriptRecord` then found no record and gave no warning. The report step found three records and did not flag the missing fourth. The record is the link between a cited decision and the bytes that ran, but each agent could remove it or change it.

## What Changes

- Each write of a decision record lands two copies. The copy in `output/` of the step stays for the agents. The host copy goes under `.sandbox/decision-records/`, at the analysis-relative path of the copy in the step.
- No file tool of an agent writes under `.sandbox/decision-records/`. The session mutator refuses such a write as `read_only`, also through a symbolic link. The step mutator cannot reach it, and the sandbox mounts it read-only.
- `edit_file` and `execute_command` read the host copy first. A change note lands in both copies.
- Before `execute_command` runs a script, it writes the copy in the step again when that copy is absent or differs from the host copy. The result names each such record in `decision_records_restored`, and the host logs a warning.
- After the agent loop and before the walk of the artifacts, the host writes again each copy in the step that is absent or changed. The provenance of such a copy keeps no producer of other bytes, and the file falls to the step activity.
- The methods of a step, the handoff of a dependency, and the methods of a run read the host copies.
- A record with no host copy is a record that an earlier version wrote. The file tools note a change in it as before, in the step only. The readers of the methods do not read it. Thus a file that an agent wrote never becomes a host record.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the host keeps a copy of each decision record, and the handoff reads the host copies.
- `step-interpretation-summary`: the methods of a step come from the host copies.
- `harness-workspace-tools`: a write under the host copies is `read_only`.

## Impact

- `src/tools/workspace/decision-record.ts`, `src/tools/workspace/mutator.ts`, `src/tools/workspace/edit-file.ts`, `src/tools/workspace/execute-command.ts`, `src/tools/knowledge/template.ts`, `src/tools/knowledge/index.ts`, `src/agents/sandbox/shared.ts`, `src/agents/conversation-agent.ts`, `src/execution/step-methods.ts`, `src/execution/run-methods.ts`, `src/execution/post-step-pipeline.ts`, `src/workflows/execute-analysis.ts`, `src/workflows/sandbox-step.ts`, and `src/workspace/paths.ts` change.
- `EditFileDeps` and `KnowledgeTemplateDeps` get the required `records` field. `ExecuteCommandDeps` gets the optional `records` field.
- Each record write is inside a tool call or inside the checkpointed step of the summary. The restore at the end of the step runs inline in the body, the same as the walk of the artifacts. It is not a DBOS operation. Thus no `DBOS.patch` is necessary.
- A step that ran before this change has no host copies. Its methods then have no template entry and no record source.
