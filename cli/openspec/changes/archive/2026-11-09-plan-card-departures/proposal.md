# Proposal

## Why

The harness gives each grounded step a list of departures from its rules. A departure can give a setting a different value, or it can stop a setting. The run binds the value of the departure. But the plan card showed the value of the rule. Thus a person could approve a plan that showed `min_count = 10`, and the run then used 5.

## What Changes

- The reader of a plan card copies the departures of each step.
- The reader shows each setting as the run binds it. A setting with a departure value shows that value, and its source names the departure. A setting that a departure does not apply shows `not applied` in its source.
- An empty value shows as `[]` or `""`, thus an empty value of the plan does not read as an absent value.
- The step dialog lists the departures of a grounded step after the settings.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `command-palette`: the step-detail dialog lists the departures of a grounded step.
- `tui-stream-blocks`: the reader of a plan card applies the departures to the settings.

## Impact

- `src/types/session.ts`, `src/modules/harness/chat_printer.ts`, `src/tui/components/dialog/plan_step_detail_dialog.tsx`, and `src/tui/layout/design_gallery_fixtures.ts` change.
- The cli reads the `departures` field of the grounding of each step of the `data-plan` part.
