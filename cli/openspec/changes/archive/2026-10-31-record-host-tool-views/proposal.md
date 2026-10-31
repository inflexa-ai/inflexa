# Proposal

## Why

Issue #785 made each tool declare a `view`: a `ToolCallView`, or `"none"`. The cli host tools declare their views in code, as the user approved in the harness change `2026-10-31-declare-tool-call-views` (design D9). But no cli spec records these decisions. Each host tool records its `describeCall` decision in its own spec, thus the view decision belongs beside it. Two of the views also have no test.

## What Changes

- `agent-cli-tool` records the view of `run_inflexa`: the input of the call, a `fields` result for each status, and the error text.
- `analysis-input-management` records the view of `manage_inputs`: the input, the result, and the error text.
- `launch-dir-listing` records that `list_launch_dir` declares `"none"`.
- A test pins the view of `manage_inputs` and the `"none"` decision of `list_launch_dir`. The view of `run_inflexa` already has tests.
- The `defineTool` entry of `harness/CONTEXT.md` names the required `view` decision. The entry also stops calling `describeCall` optional, because `describeCall` is a required decision.

No code behavior changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-cli-tool`: a new requirement for the view of `run_inflexa`.
- `analysis-input-management`: a new requirement for the view of `manage_inputs`.
- `launch-dir-listing`: a new requirement for the `"none"` view of `list_launch_dir`.

## Impact

- Specs: `cli/openspec/specs/agent-cli-tool/spec.md`, `cli/openspec/specs/analysis-input-management/spec.md`, `cli/openspec/specs/launch-dir-listing/spec.md`.
- Tests: `cli/src/modules/harness/inputs_tool.test.ts`, `cli/src/modules/harness/launch_dir_tool.test.ts`.
- Document: `harness/CONTEXT.md`, the `defineTool` entry.
- No product code changes.
