# Proposal

## Why

The sensitivity fits and the permutation calibration fit the model of the reported fit again. Each script stops when its primary fit does not agree with the results table of that fit. Thus each script must read the values that the fit read: the filter, the normalization, the design, and the columns.

The plan gives those values to the step of the fit, not to the step of the second script. The agent of the second step set them by hand. A plan setting is also not the full answer. The fit can run with a default, with a mapped policy word, with a departure, or with an override of the agent. Only the decision record of the render holds the values that the script read.

## What Changes

- The served contract of a template can carry `carried_slots`. The entry names the templates of the reported fit, the slots to bind, and the slots to show.
- At dispatch the parent reads the decision records of the steps that the step depends on. It binds each `bind` slot to the value in the one record of a named template.
- The source of a bound slot names the step and the template of the record.
- The seed shows the value of each `show` slot and does not bind it. A path is a fact of the step that wrote it. The script of a fit can also change a value at run time, for example the design.
- A carried slot binds before the settings of the step. A setting with a different value is an unbound line.
- With no such record, or with more than one, the parent binds no carried slot. The seed gives the reason.
- A record of a script that changed after its render does not prove the values that ran. The parent then binds no carried slot.
- A shell command can change a script with no note in the record. Thus the parent compares the digest of the script on disk with the digest in the record.
- The parent also binds no carried slot when it did not read each record file of a dependency.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the binding of a template can take slot values from the decision record of a step before it.

## Impact

- `src/tools/knowledge/client.ts`, `src/workflows/execute-analysis.ts`, `src/prompts/briefing.ts`, and `src/execution/step-methods.ts` change.
- A contract with no `carried_slots` reads no record and gives the same seed as before.