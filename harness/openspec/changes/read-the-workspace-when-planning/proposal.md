# Proposal

## Why

The planner and the run synthesizer could not read the workspace. The planner planned from its seed alone, thus a paper or a protocol that the user staged did not reach the plan. The synthesizer read only the step summaries, thus a fact that a summary left out and an output file held was lost.

## What Changes

- The planner declares the read tools of the workspace: `read_file`, `list_files`, `file_stat`, `grep`, `workspace_search` when an embedding provider is bound, and `inspect_data_profile`. `read_table` and `read_pdf` run in `run_script`. The planner prompt tells it to read only where the seed is thin.
- The synthesizer declares the same read tools and script reads. The synthesizer prompt tells it that the step summaries come first. The `run-synthesizer` delta of `remove-literature-reviewer` states the tools of the synthesizer, thus this change does not repeat them.
- Neither agent gets a tool that writes.

## Capabilities

### Modified Capabilities

- `planning-enhancements`: "The planner reads the workspace and writes nothing" is new.

## Impact

- `harness/src/tools/workspace/read-surface.ts`: the read tools of the workspace for an agent that plans or interprets.
- `harness/src/tools/script/file-tools.ts`: `createReadScriptTools`.
- `harness/src/tools/research/generate-plan.ts`, `harness/src/agents/conversation-agent.ts`: the `workspace` dep of the planner.
- `harness/src/execution/run-synthesis.ts`, `harness/src/app/synthesize-run.ts`, `harness/src/workflows/execute-analysis.ts`, `harness/src/runtime/assemble.ts`: the `workspace` of the synthesizer.
- `harness/src/prompts/planner.ts`, `harness/src/prompts/synthesis-agent.ts`.
- `evals/`: a synthesis agent kind and its cases.
