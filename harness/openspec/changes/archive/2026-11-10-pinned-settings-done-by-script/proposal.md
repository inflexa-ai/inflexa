# Proposal

## Why

A template can pin a slot, for example `alpha` at 0.05. A plan step can hold a setting with the same name and the same value. The seed listed that setting under `Unbound settings`, with the note that the template pins it at the same value.

That list is the list of the settings that the agent must apply or report. A setting that the script reads at the plan value needs no act of the agent. Thus the line made the agent read a gap that is not there.

The seed has a list for such a setting. A change of 2026-11-10 added `Done by the script` for a setting that the script does with no slot.

## What Changes

- The seed lists a setting that the template pins at the plan value under `Done by the script`. The line keeps the note that the template pins it at the same value.
- The seed does not list that setting as unbound.
- The heading of the list says that the script does a setting with no slot or with a pinned slot.
- A setting that the template pins at a different value stays an unbound setting.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the seed lists a setting that the template pins at the plan value as done by the script.

## Impact

- `src/workflows/execute-analysis.ts` and `src/prompts/briefing.ts` change.
- The binding does not change. A pinned slot was never a bound slot.
