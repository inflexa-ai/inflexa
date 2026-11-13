# Proposal

## Why

`execute_command` writes a run entry to the decision record of a script after the command. The entry holds the digest that the comparison before the run read.

The host can stop after the command and before the entry. The host then does the tool call again. The sandbox gives the result of the first exec, and the tool reads the digest of the script again. The script can hold different bytes at that time. Thus the entry paired the exit code of one set of bytes with the digest of a different set.

In one case the fault is not safe. The script held changed bytes when it ran, and it holds the rendered bytes again at the recovery. The entry then shows a good run of the rendered script. A step that fits the same model again then binds slot values that no result came from.

## What Changes

- The tool writes the run entry before the command, with the digest and the id of the tool call, and with no exit code.
- After the command, the tool adds the exit code to that entry.
- A tool call that the host does again finds its entry, and it compares its digest with the digest of that entry. The entry does not say if the command ran before the host stopped.
- When the two digests agree, the same bytes ran in each case, and the entry keeps `sha256`.
- When the two digests differ, the host cannot tell which bytes ran. The entry then holds the two digests and no `sha256`, thus no slot binds from it.
- An entry with no exit code is a run that did not end. It is no good run, thus no slot binds from it.
- If the write before the command fails, the tool appends the entry after the command, as before.

## Impact

- `src/tools/workspace/decision-record.ts`: `startScriptRun`, and `noteScriptRun` completes the entry of its tool call.
- A recovered call of a script that changed loses its bind. That is the safe direction.
- `src/tools/workspace/execute-command.ts`: the call of `startScriptRun` before the exec.
- A script with a record takes one more write of its record for each run.
- A script with no record gets no write. A run with no knowledge service has no record, thus nothing changes for it.
