## Context

`src/__tests__/setup/postgres.ts` gives each database test its own schema. It
reads `CORTEX_TEST_PG_URL` first. If that variable is unset, it starts a
`pgvector/pgvector:pg18` container instead.

Bun gives each test file its own module state. Thus the memoized promise of that
module is not shared between test files, and the container fallback starts one
container for each database test file. The ryuk sidecar of testcontainers is the
only thing that removes them, and ryuk does not start under podman. As a result
a bare `bun test` left one standing container for each database test file
(issue #358).

The implementation is already on the branch. This change records the behavior in
the spec, because the spec still claims one container for the whole run.

## Goals / Non-Goals

**Goals:**

- Record what the container fallback does for each database test file.
- Record the refusal as a normative behavior of the setup of the tests.
- Record that the accept-the-leak route reads two variables.

**Non-Goals:**

- Make the container fallback share one container between test files.
- Change any source file. The behavior is already implemented.
- Change how `withSchema` isolates a schema.

## Decisions

**The guard sits on the container-creation path.** A `pretest` script cannot
hold it, because `bun test` runs no lifecycle script. A `bunfig.toml` preload
cannot hold it, because bun resolves bunfig from the cwd and never walks up.
A run-level guard cannot know whether the run touches Postgres, thus it would
refuse a unit run that starts nothing. On the creation path, only a file that is
about to start a container meets the guard.

**The guard calls `getReaper` itself.** This is the same call that
`GenericContainer.start()` makes. Thus the answer is exact, and it is not a
guess about the runtime. The reaper that it starts is the same reaper that the
container start uses, memoized. As a result the guard costs nothing.

**The accept-the-leak route reads two variables.**
`CORTEX_TEST_ALLOW_LEAKED_PG=1` gets past this guard.
`TESTCONTAINERS_RYUK_DISABLED=true` is also necessary, because
`GenericContainer.start()` calls `getReaper` after the guard passes. On a host
where ryuk cannot start, that call throws, and no container is made.

## Risks / Trade-offs

- A developer on a host with no reaper cannot run a database test with one
  command. → The refusal names both safe routes and the accept-the-leak route.
- The empty-`containerId` branch of the guard is unreachable today. → It stays as
  a backstop, and its comment gives that reason.
- The spec now holds an implementation fact of Bun. → The fact controls how many
  containers a run starts, thus a reader of the spec must have it.
