# Design

## Context

`cli/src/modules/libs/build-session.ts` realizes the harness `BuildSession`. `provisioner.ts` and `store_flight.ts` launch and settle the clean run. The sibling harness change `harden-source-build-session` changes the interface (an abort signal, a commit request with `packageDir`) and the provisioner run (decision H7: the script runs as uid 1000 and cannot reach the read-write store). This change realizes both, and it closes the findings of the CLI side. See proposal.md for the list.

## Goals / Non-Goals

**Goals:**

- No code of the session can change the wall or write a host file outside the scratch volume.
- Only a clone of `github.com` receives the token.
- Each exec and each clean run ends when the turn ends.
- The host process holds bounded memory for an exec, and its event loop never waits on a folder copy.

**Non-Goals:**

- A change to the acquisition egress classes.
- A durable session across host restarts.
- Limits on the clone one-shot containers. They run fixed host commands, not session code.

## Decisions

### C1 — The token goes to an https GitHub clone alone

`start` writes the askpass helper only when the token is set, the URL scheme is `https:`, and the host is exactly `github.com`. Each other source clones with no helper. The helper keeps its own host check as a second line.

### C2 — The wall lives in a container of its own

A walled phase starts two containers. The wall container (`inflexa-build-<id>-wall`) holds `NET_ADMIN`, runs the hold command of today, and has no mount. The session container (`inflexa-build-<id>`) joins it with `--network container:<wall>`. Thus each nft rule of the shared network namespace stays out of reach: no process of the session container holds `NET_ADMIN`, and the PID namespace hides dnsmasq.

The engines differ in how a joined container gets `/etc/resolv.conf`. Thus the hold command of the session writes `nameserver 127.0.0.1` itself, and each name resolves through the dnsmasq of the wall. A query to an upstream resolver still resolves, but the wall rejects each address that dnsmasq did not add.

The session container takes `--cap-drop ALL`, then `--cap-add` for `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`, and `KILL`. These are the capabilities of apt, dpkg, the working-copy `chown`, and the abort kill. It also takes `--security-opt no-new-privileges`, `--cpus`, `--memory`, `--memory-swap` equal to the memory, and `--pids-limit 4096`. The process limit stops a fork storm of a root command before it fills the PID space of the engine host. 4096 is far above the processes of a parallel compile. The CPU and memory values come from `resourcePolicy.perStep` through a new `limits` field of `BuildSessionHost`.

A folder exploration runs the session container alone, with `--network none` and the same flags.

Alternative: keep one container and wrap each root exec in `setpriv --bounding-set=-net_admin`. Rejected. The container still holds the capability, and each host exec must stay wrapped. A container with no capability needs no such audit.

### C3 — A start clears its names and its own failure

`startContainer` first runs `rm -f` on the session name and the wall name. If any step after a `run -d` fails, it runs `rm -f` on both names before it throws. Thus the restart recovery of `exec` can always try again.

### C4 — The script file lives outside the scratch volume

`commit` makes a host directory with `mkdtemp` (`inflexa-build-script-`). It writes `build.sh` there with the flag `wx` and mode 0644. The flight binds that file read-only. The host removes the directory in a `finally` after the flight, and the exit sweep removes it too. No session container mounts that directory. Thus a link or a FIFO that a session command plants at `/work/build.sh` does nothing to the host.

### C5 — `capture` takes a byte limit and a signal

`capture` in `lib/container.ts` gains an optional options object: `{ signal?, maxBytesPerStream? }`. With a limit, each pump keeps the first half of the budget and a ring of the last half. It reads to the end of the stream, and it puts `[... N bytes not captured ...]` between the halves. An aborted signal kills the child, as in `stream`. The session exec uses 1 MiB for each stream. This equals the kept-output maximum of the harness, thus nothing that the harness can keep is lost.

### C6 — An abort stops the work inside the containers

Killing a `docker exec` client does not stop the process in the container. Thus each session exec carries a marker argument: `/bin/bash -c <command> inflexa-exec-<execId>`, which sets `$0`. On abort, the host kills the client. Then one root exec scans `/proc/*/cmdline` and sends `TERM` to each process that has an argument equal to the marker. The scan compares each argument in `sh` with `[ = ]`, thus its own arguments never match. `timeout` forwards the signal to its process group, and `--kill-after` sends `KILL` after the grace. The scan uses `sh` and `tr`, which the image holds, and no `procps` and no `grep`. A unit test pins the scan script, because the unit tests run no engine.

The clean run gets `--name inflexa-source-<uuid>`. On abort, the runner kills the client and runs `rm -f` on that name. `flySourceBuild` passes the signal, and an aborted run settles the row as `failed`.

An aborted `start` removes the named one-shot container of its current step, tears the session down, and rejects. The signal also reaches the container start and the readiness wait. An aborted plan restart removes both containers and rejects with the abort, and the session stays open.

### C7 — The folder copy is an async walk with a budget

A local helper in `build-session.ts` walks the folder with `opendir` and copies through a queue of fixed width (`p-queue`, as in `launch_dir_tool.ts`). It refuses a relative path. It refuses a FIFO, a socket, and a device file by `lstat`. It keeps a link as a link. It opens each file with `O_NOFOLLOW` and `O_NONBLOCK`, and it makes sure that the opened handle is a regular file. Thus a swap after the `lstat` cannot make it open a FIFO or follow a link. It counts the bytes that it reads, and it refuses past 2 GiB. It counts each entry, and it refuses past 200000 entries, because a tree of empty files passes the byte limit. A refusal or an abort stops the queue and removes the partial copy.

The mounted scratch directory is the 0755 child of a private 0700 `mkdtemp` parent. Thus another host user cannot read the copy in a shared `/tmp`, and each remove path removes the parent. Each directory gets mode 0755. Each file gets 0755 when any executable bit is set, and 0644 otherwise. The clean script runs as uid 1000 and must read the snapshot. The tree hash covers the executable bit alone, thus the hash does not change.

### C8 — The clean run gets a read-only view of the store

`acquireSourceArgs` adds `--name`, a read-only bind of the store root at `/opt/inflexa/libs-ro`, the argument `--lib-view /opt/inflexa/libs-ro`, and `--package-dir <dir>` when the commit names one. The read-write mount at `/mnt/libs` stays for the run itself.

### C9 — The flight removes its report on each path

The part of `flySourceBuild` after the run sits in a `try` with a `finally` that removes the report file. The debris glob of the harness change removes a report that a stopped host left.

### C10 — The JSDoc of `advance` returns to its function

`cli/src/tui/hooks/notice.ts` gets the JSDoc line back above `advance()`. The clock change stays in this pull request, because the user said to keep it there and to repair only the comment placement.

## Risks / Trade-offs

- [An engine refuses `--network container:` with the flags of the session] → Docker and Podman both accept it. A refused start removes its containers, and the error names the engine output.
- [A build needs a capability outside the install set] → The session reports the permission error, and the agent can change the strategy.
- [The `/proc` scan kills a process that copies the marker] → Only a session process can copy it, and the result is that the process stops.
- [The memory limit stops a large compile] → The limit is the per-step ceiling that the user configures for a sandbox step.

## Migration Plan

No data migration. A session container of an older build is debris that `rm -f` removes. Rollback is a revert of this change and of the harness change.
