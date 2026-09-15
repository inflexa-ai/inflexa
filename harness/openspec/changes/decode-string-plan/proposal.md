# Decode a plan that arrives as a JSON-encoded string

## Why

The arg schema of `submit_plan` is permissive on purpose. A malformed candidate reaches `execute`, and the model gets the schema issues and the semantic issues in one answer. But the permissive schema also accepts a string. Thus the loop-boundary repair, which decodes a JSON-encoded string only where a schema rejects it, never sees the plan.

A small model sends the plan as a JSON-encoded string on a large nested schema. In the Phase 0 campaign, Qwen 3.8 27B did this on every task. The planner rejected each submit with the hint, the model tried again with the same encoding, and each run ended in a blocker. The same fault can come from any weak model.

## What Changes

- `fullyValidate` in the planner decodes a JSON-encoded string before the schema check, the same as `run_synthesis` does for its permissive candidate. The issues then describe the plan inside the string.
- No change to the loop repair, to the arg schema, or to the prompt.

## Capabilities

### Modified Capabilities

- `planning-enhancements`: the re-validation of `submit_plan` decodes a JSON-encoded string.

## Impact

- `src/tools/research/generate-plan.ts`.
- A model that sends an object sees no difference.
