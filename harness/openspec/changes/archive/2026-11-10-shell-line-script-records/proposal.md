# Proposal

## Why

Before `execute_command` runs a script that has a decision record, it compares the script with the last recorded digest. It found the script only when one element of the argv was the path of the script.

A one-element argv runs through `sh -c`, and an agent uses that form for a pipe or a redirect. The element `Rscript scripts/de.R > log.txt` ends in `.txt`, thus the tool found no script. A script that a shell command changed then ran with an empty `unvetted_edits` in its record. The record said that the rendered bytes ran, and that was not true.

## What Changes

- `execute_command` finds each word with a script extension inside each element of the argv.
- A word ends at whitespace, at a shell operator, at a quote, and at the `=` of an option.
- A relative word resolves against the cwd of the command, and against each directory that a `cd` before the word can give.
- The comparison reads no more than 16 paths from the words of the shell lines of one command.
- The command runs as the model sent it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the digest comparison before a run also finds a script inside a shell line.

## Impact

- `src/tools/workspace/execute-command.ts` changes.
- A script with no record gets one more read of a record path and no other effect. A run with no knowledge service has no record, thus its commands run as before.
