# Proposal

## Why

The review of pull request #753 found defects in the CLI realization of the source build session. The clone gives `GITHUB_PAT` to any host that the git URL names. A session command can redirect the host write of `build.sh` through a symbolic link. A root exec keeps `CAP_NET_ADMIN` and can delete the egress wall.

The review found more defects. A failed start leaves a container that blocks each retry. The exec output has no byte limit. A canceled turn does not stop an exec or a clean run. A refused clean run leaves its report file. The folder copy is synchronous and has no size limit.

## What Changes

- The clone gives the token only to an `https` URL whose host is `github.com`. Each other source clones with no credential.
- A walled session is two containers. A wall container holds the egress rules and `NET_ADMIN`. The session container joins the network of the wall container.
- The session container has no `NET_ADMIN`. It drops each capability that a build does not use, and it sets `no-new-privileges`.
- The session container takes the memory and CPU limits of one sandbox step, and a process limit.
- Each start of a session container first removes a container of the same name. A start that fails after the container exists removes it.
- The host writes the approved script into a host directory that no session container mounts. The clean run binds that file read-only.
- The clean run mounts a second, read-only view of the store for the dependency library of the script.
- Each exec output keeps at most 1 MiB for each stream, the head and the tail. A marker names the bytes that it dropped.
- An abort of the turn stops the command in the session container, and it removes the clean-run container.
- The folder copy is asynchronous. It refuses a relative path, a special file, and a tree larger than 2 GiB.
- The folder copy makes each file readable for uid 1000.
- The flight removes the `source-*.json` report on each path after the run.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `source-build-session`: the token rule, the container topology, the restart cleanup, the script location, and the exec output limit.
- `source-build-session` also changes for the abort, the folder copy, and the report cleanup.

## Impact

- `cli/src/modules/libs/build-session.ts`, `provisioner.ts`, `store_flight.ts`, and their tests.
- `cli/src/lib/container.ts` — `capture` gains a byte limit and an abort signal.
- `cli/src/modules/harness/runtime.ts` — the binding passes the per-step resource limits.
- `cli/src/tui/hooks/notice.ts` — the JSDoc of `advance` goes back above its function (no behavior change).
- The sibling harness change `harden-source-build-session` changes the `BuildSession` interface and the provisioner image. The two changes must land together.
