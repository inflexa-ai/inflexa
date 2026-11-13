# Proposal

## Why

In the run of analysis GSE136961, the plan card showed the id, the name, and the agent of each step. The step dialog showed the question, the criteria, the constraints, and the caveats. The reader of the plan card dropped the grounding of each step. Thus a person could not see which rules set a step, how strong they are, or which papers support them.

## What Changes

- The reader of a plan card copies the grounding of each step. It joins each claim id to the claim view of the card by the id and the snapshot digest.
- The step dialog shows the grounding of a grounded step: the status, the knowledge release, the template, the reason, the rules, the settings, and the sources.
- The plan card shows one grounding line under the plan body.
- The design gallery shows a grounded step and a grounded plan.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `command-palette`: the step-detail dialog shows the grounding of a grounded step.
- `tui-stream-blocks`: the plan card shows the grounding of the plan.

## Impact

- `src/types/session.ts`, `src/modules/harness/chat_printer.ts`, `src/tui/components/plan_card_block.tsx`, `src/tui/components/dialog/plan_step_detail_dialog.tsx`, and `src/tui/layout/design_gallery_fixtures.ts` change.
- The cli reads the `claims` field of the `data-plan` part and the `grounding` of each step from the harness.
