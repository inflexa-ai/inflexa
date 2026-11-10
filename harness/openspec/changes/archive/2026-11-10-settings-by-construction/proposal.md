# Proposal

## Why

The seed lists each plan setting that no slot carries as an unbound setting. Some of those settings are things that the script of the template always does. The edgeR script filters with `filterByExpr`, fits the quasi-likelihood F-test, and adjusts by Benjamini-Hochberg. No slot holds these settings, because the script has no other way.

In the run of analysis GSE136961, the edgeR step listed such settings as unbound. The agent then cannot tell a setting that the script does from a setting that the agent must apply. The agent reads each line, and it can do the work a second time or report a gap that is not there.

A rule names no template, thus the rule cannot say what a script does. The template knows it.

## What Changes

- The served contract of a template can carry `settings_by_construction`. Each entry names one setting with the value that the script does with no slot.
- The seed lists a setting of the step with the name and the value of an entry under `Done by the script`. The seed does not list it as unbound.
- The binding holds no slot and no source for such a setting. The decision record holds only what the script reads.
- A plan value that differs from the value of the entry is a conflict. The seed lists it as unbound and names the value that the script does.
- A departure that removes the setting is also a conflict, because the script has no slot for it. The seed lists it as unbound with that reason.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the seed tells a setting that the script does from a setting that no slot carries.

## Impact

- `src/tools/knowledge/client.ts`, `src/workflows/execute-analysis.ts`, and `src/prompts/briefing.ts` change.
- A contract with no `settings_by_construction` gives the same seed as before.