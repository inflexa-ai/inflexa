# The compose stack works on a Windows host

## Why

Issues #560 and #561 report that `inflexa setup` and `inflexa` fail on each
Windows host. The generated compose file has two defects, and the readiness
wait has one.

First, the template writes each host path raw into a double-quoted YAML scalar
(`src/modules/infra/compose.ts:81`, `:82`, `:105`). In that scalar, a backslash
starts an escape. Thus `\U` in `C:\Users` reads as a Unicode escape, and the
compose tool rejects the file. `escapeYaml` is in the same file
(`compose.ts:46`), but only the `POSTGRES_*` values use it.

Second, the Postgres service bind-mounts a host directory as its data
directory (`compose.ts:105`). On a Windows host, the file share between the
host and the Linux machine of the engine refuses `chmod`. `initdb` sets the
mode of the data directory, thus `initdb` fails at each start. The restart
policy starts the container again, and the container never becomes ready.

Third, the readiness wait polls `pg_isready` for 30 seconds, and then it
reports only a timeout (`src/modules/infra/postgres.ts:33`). It does not read
the state of the container. Thus a restart loop looks the same as a slow
start, and the user does not see the `initdb` error that the container log
holds.

No Windows install works today, because the first defect stops each one. As a
result, no Windows host holds Postgres data that this change must keep.

## What Changes

- The compose template escapes each host path for the double-quoted YAML
  scalar. A path with a backslash or a quotation mark gives a valid file.
- On a Windows host, the Postgres service keeps its data in a named volume of
  the container engine. The name of the volume is channel-aware. A host that
  is not Windows keeps the bind mount, and its compose file does not change.
- On a Windows host, the mount manifest lists no Postgres data directory.
  Thus the guard makes no directory that nothing mounts.
- On a Windows host, `inflexa down --delete-data` also removes the named
  volume, and the confirmation prompt names the volume.
- On a Windows host, the help row for the Postgres data directory says that a
  named volume holds the data.
- The readiness wait reads the restart count of the container. When the count
  rises by 2 during the wait, the wait stops at once with a restart-loop
  error. That error carries the last lines of the container log. The timeout
  error carries the same lines.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-provisioning`: the persistence rule of the Postgres service gets a
  Windows branch. The channel-aware identity gets the name of the volume.
  `inflexa down --delete-data` and the help row get a Windows branch. Two
  requirements are new: the compose file is valid YAML for each host path, and
  the readiness wait reports a restart loop.
- `infra-state-resilience`: the mount-source integrity requirement says that a
  named volume is not a mount source. Thus the manifest of a Windows host
  lists no Postgres data directory.

## Impact

- `src/modules/infra/compose.ts`: `generateComposeFile`, `mountManifest`, a new
  constant for the name of the volume, and a new function that removes the
  volume.
- `src/modules/infra/postgres.ts` and `src/modules/infra/postgres_types.ts`:
  `waitForReady`, and a new `container_crash_loop` member of `PostgresError`.
- `src/modules/infra/lifecycle.ts`: `down` and `confirmDeleteData`.
- `src/lib/env.ts`: the description of `postgresDataDir` in the path registry.
- `src/modules/infra/compose.test.ts` and `src/modules/infra/postgres.test.ts`.
- No new dependency. No change to the harness. No data migration.
