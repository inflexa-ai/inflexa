# Design

## Context

See proposal.md for the reason. The views exist in code:

- `run_inflexa`: `cli/src/modules/harness/inflexa_tool.ts:524-528`, with the result from `resultView` at `:182-207`. Tests: `cli/src/modules/harness/inflexa_tool.test.ts:789-830`.
- `manage_inputs`: `cli/src/modules/harness/inputs_tool.ts:120-124`. No test.
- `list_launch_dir`: `cli/src/modules/harness/launch_dir_tool.ts:89`. No test.

The spec of each tool holds a requirement for its `describeCall` decision. The test file of each tool holds a `— describeCall` block. `defineTool` drops the `"none"` sentinel, thus a tool that declares `"none"` has no `view` key (`harness/src/tools/define-tool.ts:381`).

The `defineTool` entry of `harness/CONTEXT.md` (`:609-641`) shows the fields of a definition. It omits `view`, and it calls `describeCall` optional. `describeCall` is a required decision, a function or `"none"` (`harness/src/tools/define-tool.ts:259`).

## Goals / Non-Goals

**Goals:**

- Each cli host tool has a spec requirement and a test for its view decision.
- The harness glossary shows the required `view` decision.

**Non-Goals:**

- No change of a view. The user approved each view in design D9 of the harness change `2026-10-31-declare-tool-call-views`.
- No renderer of the values in the TUI.

## Decisions

### D1. Each view requirement goes in the spec of its tool

The requirement goes beside the `describeCall` requirement of the same tool. The alternative is one requirement in `harness-runtime` that lists the three host tools. That puts a decision of a tool far from the other decisions of the same tool.

### D2. A test reads the view members directly

The tests call the members of the packaged view, as the `run_inflexa` view tests do. The harness tests already cover what the loop does with a view. A loop test in the cli would test the harness again.

### D3. The harness glossary edit rides in this change

The edit is one entry of `harness/CONTEXT.md`, and it changes no spec of the harness. The harness change `2026-10-31-declare-tool-call-views` edited cli files in the same way. A second change for one glossary entry adds a full review cycle and no safety.

## Risks / Trade-offs

- [A direct read of the members does not show the value that the loop makes] → The harness tests cover the cleaning, the kinds, and the cap. The cli tests pin the decision of each tool.
