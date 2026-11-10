# Tasks

## 1. The record

- [x] 1.1 Add `startScriptRun` to `src/tools/workspace/decision-record.ts`. It writes the entry with no exit code, or it gives the digest of the entry that is there.
- [x] 1.2 Make `noteScriptRun` add the exit code to the entry of its tool call. When the digest of the call differs from the digest of the entry, write the two digests and no `sha256`.

## 2. The tool

- [x] 2.1 Call `startScriptRun` before the exec in `src/tools/workspace/execute-command.ts`. A failed write is a warning.

## 3. Tests

- [x] 3.1 The entry is in the two copies of the record before the command ends.
- [x] 3.2 A recovered call keeps `sha256` for the same bytes. It writes two digests and no `sha256` for a script that changed, and for a script that changed back.
- [x] 3.3 A record with an entry that has no exit code, or no `sha256`, binds no carried slot.

## 4. The spec

- [x] 4.1 Change the requirement "The decision record follows the script" in `openspec/specs/knowledge-plane-tools/spec.md`.
