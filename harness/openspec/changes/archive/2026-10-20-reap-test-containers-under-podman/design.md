## Context

See `proposal.md` for the leak and its cause. These facts shape the approach:

- `startContainer` (`src/__tests__/setup/postgres.ts`) calls the guard only when
  `CORTEX_TEST_PG_URL` is unset. `scripts/test-full.sh` and the CI harness job
  export that variable. Thus they never reach the guard or testcontainers.
- testcontainers 10.28.0 reads `TESTCONTAINERS_RYUK_PRIVILEGED` lazily, in
  `createNewReaper`, when `getReaper` makes a new ryuk. It reads
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` and `DOCKER_HOST` one time, when
  `getContainerRuntimeClient` first resolves the runtime, and it keeps the
  result. `~/.testcontainers.properties` has no key for either ryuk variable.
- Without `DOCKER_HOST`, testcontainers uses `/var/run/docker.sock` on macOS.
  Ryuk bind-mounts the same path from inside the VM.
- The probe machine is a rootful podman machine. Inside the VM,
  `/var/run/docker.sock` links to `/run/podman/podman.sock`, and SELinux runs
  in enforcing mode. Docker Desktop also runs on that host.

Probe results, with `TESTCONTAINERS_RYUK_PRIVILEGED=true` and no other
testcontainers variable:

- podman: `getReaper` started `testcontainers/ryuk:0.11.0`. A `GenericContainer`
  of `pgvector/pgvector:pg18` started. After the process exited, ryuk removed
  the pgvector container, its anonymous volume, and itself.
- Docker Desktop (`DOCKER_HOST` at the Docker Desktop socket): `getReaper`
  started a privileged ryuk, and ryuk removed itself after the exit.

Without the privileged flag, ryuk on podman fails with "permission denied" on
the socket. testcontainers reports that as
`Log stream ended and message "/.*Started.*/" was not received`.

## Goals / Non-Goals

**Goals:**

- A plain `bun test` on a rootful podman machine starts ryuk with no setting
  from the developer.
- No route of the guard lets a container start without a running reaper.

**Non-Goals:**

- Share one container between the test files of a fallback run. `bun run
  test:full` and `CORTEX_TEST_PG_URL` stay the routes for that.
- Detect a rootless podman machine and set the socket override for it.
- Remove a container that `test-full.sh` started when the script gets SIGKILL.
- Change CI.

## Decisions

**The guard sets `TESTCONTAINERS_RYUK_PRIVILEGED=true` when it is unset.** The
guard runs on each path that creates a container, and it runs before the first
`getReaper` call of the process. testcontainers reads the variable lazily. Thus a
value set there reaches `createNewReaper`. The guard keeps a value that the
developer set, so a developer can still choose `false`.

Alternatives:

- Set it in `test-full.sh`. That has no effect, because the script exports
  `CORTEX_TEST_PG_URL`, and the fallback never runs under it.
- Set it in a `bunfig.toml` preload. Bun resolves bunfig from the cwd only.
  Thus `cd src/state && bun test` misses it. The same reason keeps the guard on
  the creation path.
- Set it in a `.env.test` file. The harness keeps no such file, and the value
  then lives apart from the guard that depends on it.
- Document the variable and let the developer export it. A plain `bun test`
  then refuses until the developer acts. The goal is a plain run that cleans up.
- Set it only when the runtime is podman. The runtime info of testcontainers
  holds no reliable podman marker. The probe shows that a privileged ryuk also
  works on Docker Desktop. Ryuk already holds the runtime socket, which gives
  it root on the runtime. Privileged mode adds no real authority.

**The guard sets no socket override.** On a rootful machine the default path
inside the VM already reaches podman. A rootless machine has its socket at
`/run/user/<uid>/podman/podman.sock`. There, the root-owned default socket
refuses the rootless ryuk, `getReaper` throws, and the guard refuses. Thus the
rootless case fails closed. The refusal names
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` for it.

**The default goes through one exported function that takes the environment.**
The guard calls it after the `TESTCONTAINERS_RYUK_DISABLED` check and before
`getReaper`. A unit test calls the function with a plain object. Thus the test
covers the default and the kept value without a start of ryuk, which the test
file of the guard must not do.

**The guard has no opt-out.** `CORTEX_TEST_ALLOW_LEAKED_PG` goes from the code,
the message, `CLAUDE.md`, and the spec. The test of the disabled ryuk also sets
`CORTEX_TEST_ALLOW_LEAKED_PG=1`, to prove that the removed variable does not get
past the guard. The archive of an earlier change still names the variable. That
text is history, and it stays.

**The refusal names the podman variables in place of the bypass.** It keeps the
two routes that start one container for the run. Then it tells the developer to
unset `TESTCONTAINERS_RYUK_DISABLED`, and it names `DOCKER_HOST`,
`TESTCONTAINERS_RYUK_PRIVILEGED=true`, and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`, each with the condition where it
applies.

**`test-full.sh` names its container and sets the trap first.** Today the script
sets its `EXIT` trap after `docker run` returns the container id. An interrupt
in that gap leaves a running container and its anonymous volume. The script
makes a name from its process id and a random value, sets the trap on that name,
and then runs `docker run --name`. `docker rm -f -v` on a name that does not
exist yet fails, and the trap ignores that failure.

## Risks / Trade-offs

- [The containers of a plain `bun test` stay until ryuk runs after the exit.] → `bun run test:full` stays
  the documented route for the full suite. `CLAUDE.md` states the cost.
- [A rootless podman machine still refuses.] → The refusal names the socket
  override. The refusal is safe, because no container starts.
- [A SIGKILL of `test-full.sh` runs no trap, so the container and its volume
  stay.] → No trap can run on SIGKILL. The change states this limit, and it adds
  no sweep. A sweep by label can remove the container of a parallel run in a
  sibling clone.
- [A future testcontainers version can read `TESTCONTAINERS_RYUK_PRIVILEGED` at
  import.] → The probe and the scenario "A plain run on a rootful podman machine
  removes its containers" catch it when the version changes.
