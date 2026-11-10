# Tasks

## 1. The record

- [x] 1.1 Add `noteScriptRun` to `src/tools/workspace/decision-record.ts`, with the two copies of the record.
- [x] 1.2 Give the digest of the comparison before the run to the caller.
- [x] 1.3 Add `runs` to the record schema in `src/execution/step-methods.ts`, and `recordHasRenderedRun`.

## 2. The tool

- [x] 2.1 Add `runScriptPathsOf`, which gives the scripts that a command runs.
- [x] 2.2 Write the run entry after the exec, and never fail the call on a failed write.

## 3. The binding

- [x] 3.1 Bind a carried slot only from a record with a run of the rendered bytes that ended with exit code 0.

## 4. The tests

- [x] 4.1 Add the tests of the run entry: the two copies, a changed script, and a command that reads the script.
- [x] 4.2 Add the tests of the binding: no run, a failed run, a run of different bytes, and one good run among failed runs.
