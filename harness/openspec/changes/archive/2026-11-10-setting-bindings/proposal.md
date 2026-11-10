# Proposal

## Why

In the run of analysis GSE136961, the edgeR step had 40 settings from its rules, and the host bound 0 of them. The host binds a setting to a slot by name. Most settings of a rule are policy words: an instruction to the agent or to the report. A policy word is not a value of a slot, thus no name can bind it.

Some policy words have one slot value in one template. R-0571 gives the scale of a targeted panel as `global_shift_policy`. The edgeR template realizes that policy with `normalization_source = external`. The rule names no template and no slot, thus the plan could not bind the slot, and the agent set it by hand.

## What Changes

- The served contract of a template can carry `setting_bindings`. Each entry maps one setting with one value to one slot with one slot value.
- The binding of the template contract binds the slot of an entry when a setting of the step has the name and the value of that entry.
- The binding reads the setting after its departure. A departure that changes the value binds the slot only when an entry maps the new value. A departure with no value binds nothing and excludes no slot, because the slot then takes the default of the template.
- The source of the bound slot names the setting and the source of the setting.
- A map that the served contract does not take binds nothing. The seed lists the setting as unbound with the reason.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the plan settings bind through the map of the contract, and by name as before.

## Impact

- `src/tools/knowledge/client.ts` and `src/workflows/execute-analysis.ts` change.
- A contract with no `setting_bindings` binds as before.
