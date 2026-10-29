# Proposal

## Why

The review of pull request #753 found defects in the source build session (`add-source-build-session`). A folder `start` reads any host folder with no approval. The clean run executes the approved script as root, with `NET_ADMIN` and a store that it can write. A plan host can be any string.

The review found more defects. A canceled turn does not stop a command or a clean run. Two calls of one session can run at the same time. An R package in a subdirectory gets no dependency install, but the tool text says that a custom script is sufficient. A failed dependency install of a Python root stops the run with no report.

## What Changes

- Each `start` asks the user first. The ask shows the source: the folder path, or the git URL and its ref. A rejection starts nothing.
- The tool schema accepts a host name only: two or more DNS labels, letters in the last label, no slash, no comma. The check ignores case, and the tool gives the host in lower case. The same rule applies to the host of a git URL.
- The tool holds a lock for each session. Two calls on one session never overlap, in one round or across turns. Thus a plan restart never removes the container under a command.
- **BREAKING** (interface): `BuildSession.start`, `exec`, and `commit` take the `AbortSignal` of the turn.
- **BREAKING** (interface): `commit` takes a request object that holds the script and an optional package directory.
- `commit` accepts `packageDir`, a relative directory of the source tree that holds the R `DESCRIPTION`. The clean run resolves the R dependencies from that directory. The build record holds it.
- The tool description says that a plan restart removes everything outside `/work`.
- The tool description says that the clean run installs the apt packages of the plan and runs the script as the non-root user.
- `acquire-source` installs the apt packages of the plan as root. Then it runs the script as uid 1000 through `setpriv`.
- The script runs with no capabilities, with `no-new-privs`, and with no path to the read-write store. It reads its dependency library through a read-only view of the store.
- `acquire-source` refuses an apt package name that is not a Debian package name.
- `acquire-source` changes a failed dependency install of a Python root into a refusal. The refusal removes the new store directories of the run, and the run writes its report.
- `reclaim --debris` also removes the stale `source-*.json` reports.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `source-build-session`: the start ask, the host shape, the serial calls, the abort signal, the package directory, and the tool text.
- `package-store-provisioner`: the privilege drop, the apt install, the package directory, the dependency refusal, and the debris glob.

## Impact

- `harness/src/sandbox/types.ts` — the `BuildSession` signatures and `BuildCommitRequest`.
- `harness/src/tools/install-from-source.ts` and its tests.
- `images/sandbox-provisioner/provision.py` and `test_provision.py`.
- The sibling CLI change `harden-source-build-session` (cli tree) realizes the interface changes. It also changes the container topology, the token rule, and the exec output limit.
- The two changes must land together.
