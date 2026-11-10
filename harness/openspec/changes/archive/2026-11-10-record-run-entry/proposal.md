# Proposal

## Why

A decision record says which template a script came from and which slot values the render used. It did not say that the script ran.

A step that fits the model of a reported fit again takes its slot values from the record of that fit. An agent can render a template and then run a different script. The record of the render then gives values that no result came from, and the second fit binds them.

## What Changes

- After `execute_command` runs a script that has a record, it appends an entry to `runs` in the record. The entry holds the exit code of the command and the digest of the script before the run.
- The tool writes the entry only when the exit code of the command is the exit code of the script. That is a direct call of the script or of its runner. It is also a shell line that is such a call, or a chain of `&&` that ends with one.
- A command before the last one of a chain can be only `cd` or `mkdir -p`.
- A pipe, a list, a subshell, a quote, an expansion, and an input redirect give no entry. A command that reads the script as data gives no entry.
- A failed write of the entry is a warning. It does not fail the call.
- The parent binds a carried slot only from a record that holds a run of the rendered bytes with exit code 0.
- Without such a run, the seed gives the reason, and the agent reads the values from the script that gave the results.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the decision record holds the runs of its script, and a carried slot binds only from a record with a good run.

## Impact

- `src/tools/workspace/decision-record.ts`, `src/tools/workspace/execute-command.ts`, `src/execution/step-methods.ts`, and `src/workflows/execute-analysis.ts` change.
- A record of an older version has no `runs`. A second fit binds nothing from it, and the seed gives the reason.
- A script with no record gets no write. A run with no knowledge service has no record, thus its commands run as before.
- Known limit: the entry proves that the rendered script ended with exit code 0. It does not prove that the results table of the step came from that script.
- Each update of a record waits for the update before it. An entry holds the id of its tool call, thus a call that the host does again writes no second entry.
- Known limit: the host can stop after the command and before the entry. The recovery then reads the digest of the script again. A script that changed in that time gets a change note and an entry with the new digest, thus no slot binds.
- Known limit: the host does not parse the shell. A script that runs through a pipe, for example with `tee`, gets no entry, and a second fit then binds nothing. The seed gives the reason.
