# Tasks

## 1. The capture helper

- [x] 1.1 Give `capture` in `cli/src/lib/container.ts` an optional options object `{ signal?, maxBytesPerStream? }` (decision C5). With a limit, keep the first half and the last half of the budget for each stream. Read each stream to its end, and put `[... N bytes not captured ...]` between the halves. An aborted signal kills the child. Prove it with new cases in `cli/src/lib/container.test.ts` for the head and the tail, the marker count, an output under the limit, and an abort.

## 2. The session realization

- [x] 2.1 Change `cli/src/modules/libs/build-session.ts` to the new harness signatures: `start(source, analysisId, signal)`, `exec(handle, command, signal)`, and `commit(handle, request, signal)`. Pass `packageDir` and the signal into the flight. Prove it with `cd cli && bun run typecheck` after the harness build of its task 1.6.
- [x] 2.2 Give the token to the clone only for an `https:` URL whose host is `github.com` (decision C1). Prove it with cases in `build-session.test.ts`: `gitlab.com`, `http://github.com`, and `https://github.com` with the token.
- [x] 2.3 Split a walled phase into the wall container and the session container (decision C2). Add the `limits` field to `BuildSessionHost` for the CPU and memory flags. Add the session hardening flags and the resolver line in the hold command. Make the teardown, `stop` of a lost session, and the exit sweep remove both names. Update the module JSDoc and the `writeAskpass` JSDoc for the new topology and the token rule. Prove it with cases that pin the arguments of each container and the removal of both names. Pin the folder start with `--network none` and the same flags.
- [x] 2.4 Make `startContainer` remove both names before `run -d`, and remove both names when a later step fails (decision C3). Prove it with a case where the wall never reports active, and the retry of the next exec starts with no name conflict.
- [x] 2.5 Write the commit script into its own `mkdtemp` directory with the flag `wx` and mode 0644 (decision C4). Remove the directory after the flight and at the exit sweep. Prove it with a case that plants a link at `<scratch>/build.sh`: the link target is unchanged, and the flight receives the path in the new directory.
- [x] 2.6 Bound the exec output to 1 MiB for each stream through `capture` (decision C5). Add the marker argument to each exec, and stop the command on abort with the root `/proc` scan that compares exact arguments (decision C6). Name the clone one-shot containers, and make an aborted `start` remove the one-shot and tear the session down. Prove it with cases that pin the exec argv with the marker, the kill exec after an abort, and the bound passed to the runner.
- [x] 2.7 Replace `cpSync` of a folder source with the asynchronous walk (decision C7). It refuses a relative path, a FIFO, a socket, a device file, and more than 2 GiB of read bytes. It opens each file with no follow and no block, and it removes a partial copy on a refusal or an abort. It keeps each link as a link, and it sets the modes 0755 and 0644. Prove it with cases over a temporary folder: a FIFO refusal, a size refusal with a small injected budget, an abort, a kept link, and the modes.

## 3. The flight

- [x] 3.1 In `cli/src/modules/libs/provisioner.ts`, add to `acquireSourceArgs` the container name, the read-only store view at `/opt/inflexa/libs-ro`, `--lib-view`, and `--package-dir` when set (decision C8). Make `runSourceBuild` run `rm -f` on the name after an abort (decision C6). Prove it with the pinned launch case in `store_flight.test.ts`.
- [x] 3.2 In `cli/src/modules/libs/store_flight.ts`, pass the signal and `packageDir` through `flySourceBuild`, and settle an aborted run as `failed`. Remove the report file in a `finally` on each path after the run (decision C9). Prove it with cases for a refused run, a failed check, and an abort: no report file remains, and the row is `failed`.

## 4. The binding and the notice comment

- [x] 4.1 In `cli/src/modules/harness/runtime.ts`, pass `{ cpu: resourcePolicy.perStep.maxCpu, memoryGb: resourcePolicy.perStep.maxMemoryGb }` as the `limits` of `createBuildSession`. Prove it with `runtime.test.ts`.
- [x] 4.2 Move the JSDoc line of `advance()` in `cli/src/tui/hooks/notice.ts` back above `function advance()` (decision C10). Prove it with `bun run lint`.

## 5. Verification

- [x] 5.1 Run `cd cli && bun run format:file <changed files>`, `bun run lint`, `bun run typecheck`, and the changed test files. Then run the full suite `bun run test` one time.
- [x] 5.2 Run `cd cli && openspec validate harden-source-build-session --strict`, and make sure that it passes.
