# Design: the compose stack works on a Windows host

## Context

`src/modules/infra/compose.ts` makes the compose file as a string template,
because the cli has no YAML dependency. `generateComposeFile` reads the three
host paths from `env` and writes each one into a double-quoted scalar.
`mountManifest` reads the same paths, and the guard in `ensureMountSources`
makes each directory before the engine runs. The `postgres-provisioning` spec
requires a bind mount for the Postgres data directory.

`waitForReady` in `src/modules/infra/postgres.ts` is the one readiness wait.
`inflexa setup` reaches it through `provisionPostgres`. The launch gate and the
harness boot reach it through `ensurePostgresReady`. On the bare `inflexa`
path, the wait runs behind the boot animation of the TUI
(`src/tui/app.launch.tsx:104`).

The reporter of #560 and #561 uses Podman on Windows 11, with
`docker-compose.exe` as the compose provider. No maintainer has a Windows
host. Thus each decision here must be correct by construction, and each one
must have a unit test that runs on a POSIX host.

## Goals / Non-Goals

**Goals:**

- A Windows host gets a compose file that parses.
- A Windows host gets a Postgres container that starts and keeps its data.
- A restart loop of the Postgres container gives a clear error in seconds, on
  each platform, with the cause from the container log.
- A host that is not Windows gets the same compose file as before.

**Non-Goals:**

- No move of the macOS or Linux data into a named volume.
- No long `type: bind` volume syntax. The short syntax works on Windows when
  the quotation is correct, as the workaround in #560 shows.
- No time limit on one `capture` call. Refer to the open question.
- No change to the one-shot login container. It gets its paths as process
  arguments, not through YAML, thus #560 does not touch it.

## Decisions

### D1. `escapeYaml` on each host path

The three volume lines wrap the host path in `escapeYaml`. The function
doubles each backslash and escapes each quotation mark, thus the YAML parser
gives back the exact path.

Alternatives that were set aside:

- **Single quotation marks.** A single-quoted scalar has no backslash escape.
  But a path can hold `'`, for example in a user name. That case must have a
  second escape function, and one escape function is in the file already.
- **Forward slashes.** This changes the text of the path that the engine
  gets. The escape is lossless, and it makes no assumption about the engine.

### D2. One function gives the location of the Postgres data

A new exported function in `compose.ts` gives the location:

```ts
type PostgresDataLocation =
    | { kind: "bind"; path: string }
    | { kind: "volume"; name: string };

function postgresDataLocation(host: ComposeHost): PostgresDataLocation
```

It gives `volume` when `host.platform` is `win32`, and `bind` for each other
platform. It has three readers:

- `generateComposeFile` writes the volume line from it. For `volume`, it also
  writes the top-level `volumes:` block.
- `mountManifest` lists the data directory only for `bind`.
- `confirmDeleteData` in `lifecycle.ts` names the location in its prompt.

The `infra-state-resilience` spec says that the manifest and the template
derive from the same facts. One function keeps that true for the new branch.

The key is the platform, not the engine. The cause is the file share between
a Windows host and the Linux machine of the engine. Each engine on Windows
has such a share. A named volume is correct under each engine. Thus
the platform key has no cost for Docker on Windows, where no report exists.
A Linux binary inside WSL reads `linux`, and its data directory is on a Linux
file system, thus it keeps the bind mount.

Alternatives that were set aside:

- **A named volume on each platform.** Each macOS and Linux install holds its
  DBOS state and its vectors in the bind directory. A move must copy that
  data through a helper container. That is a risk with no gain, and the spec
  says that the production paths do not change.
- **A `user:` override or a different `PGDATA`.** The share refuses `chmod`
  for each user and at each path below the mount.

### D3. `ComposeHost` is the seam for the platform and the paths

```ts
type ComposeHost = {
    platform: NodeJS.Platform;
    cliproxyConfigPath: string;
    cliproxyAuthDir: string;
    postgresDataDir: string;
};
```

`generateComposeFile`, `mountManifest`, and `postgresDataLocation` take an
optional `host: ComposeHost`. The default comes from `process.platform` and
`env`. Each production caller omits the argument. Only a test gives one.

This is the pattern of `EngineSocketProbes` in `src/lib/container.ts`, and of
the `platform` parameter of `openerArgv`. The paths are part of the seam
because `env` fixes them at import. Without them, no test on a POSIX host can
put a backslash path through the template.

### D4. The volume has an explicit, channel-aware name

```yaml
volumes:
  inflexa-postgres-data:
    name: inflexa-postgres-data
```

The name is `${PREFIX}-postgres-data`, thus `inflexa-postgres-data` in
production and `inflexa-dev-postgres-data` in dev. The constant
`POSTGRES_VOLUME_NAME` is exported.

Without `name:`, the compose tool adds the project name as a prefix, and the
result depends on the provider. With `name:`, the cli knows the one name, and
it can remove the volume with no compose file on disk. This is the same
reason that `composeProxyRunning` asks the engine and not the compose tool.

### D5. `down --delete-data` removes the volume through the engine

A new function in `compose.ts`:

```ts
function removePostgresVolume(
    rt: ContainerRuntime,
): Promise<Result<"removed" | "absent", { type: "volume_remove_failed"; message: string }>>
```

It runs `volume inspect <name>` first. A non-zero exit means that the volume
is absent, and that is `ok("absent")`. Then it runs `volume rm <name>`. A
non-zero exit gives the error with the stderr text. The error type is narrow,
because the function fails in one way only.

`down` calls it on each platform, after `composeDown`, because the container
must be gone before the engine lets the volume go. On a host that is not
Windows, the volume is absent, and the call does nothing. Thus `down` has no
platform branch of its own. `down` also keeps the `rmSync` of the data
directory on each platform. On Windows, that removes a directory that an
older build made, and it does nothing when the directory is absent. A failed
removal prints a warning, the same as a failed `rmSync` does today.

`compose down -v` was set aside. It reads the compose file on disk, and
`inflexa down` never writes that file. Thus a missing file or an old file
hides the volume from it.

### D6. The restart count finds the restart loop

In `waitForReady`, after each failed `pg_isready`, the loop reads the restart
count:

```
<rt.bin> inspect --format {{.RestartCount}} <container>
```

The first good read is the baseline. When a later read is 2 or more above the
baseline, the wait gives `container_crash_loop` at once. When the read fails,
or when the text is not a number, the loop ignores it, and the wait keeps the
timeout path.

- **The count, not the status.** In a restart loop, the status moves between
  `running`, `exited`, and `restarting`. A poll each 500 ms can read `running`
  each time. The count only rises.
- **A rise, not a value.** The count is for the life of the container. A
  container that the engine restarted one time last month is healthy today.
  Only a rise during the wait is a sign of a loop.
- **A rise of 2, not of 1.** One exit during the first start is possible on a
  small machine. The second restart comes one or two seconds after the first,
  thus the margin is cheap.

A healthy first start does not raise the count. The two-phase start of the
Postgres image restarts the server inside the container, not the container.

### D7. The two errors carry the last lines of the container log

A helper in `postgres.ts` runs `logs --tail 20 <container>`. It joins stdout
and stderr, because the entrypoint writes the `initdb` error to stderr. It
gives an empty string when the call fails. `container_crash_loop` and
`ready_timeout` put the lines into `message`, and they name the command for
the full log.

Each consumer prints `message` as it is. No consumer has a `switch` on the
type of a `PostgresError`. Thus the new member of the union breaks no build,
and the TUI boot error shows the `initdb` line with no change to the TUI.

### D8. The help row tells the truth on Windows

The description of `postgresDataDir` in the path registry of
`src/lib/env.ts` is a conditional on `process.platform`. On `win32`, it says
that the directory is not in use, and that a named volume of the container
engine holds the data. `lib/` cannot import a module, thus the text does not
give the name of the volume.

## Risks / Trade-offs

- [No maintainer can run the change on Windows] → Each branch has a unit test
  through `ComposeHost`. The two generated files are text that a reviewer can
  read. The reporter of #561 ran the named-volume form by hand, and it worked.
- [A compose provider ignores `name:` on a volume] → `docker-compose` and
  `podman-compose` both obey it. If one does not, the data is safe, and only
  `--delete-data` does not find the volume. It then prints nothing about the
  volume, because `volume inspect` reports it as absent.
- [An engine gives no `RestartCount`] → The read fails, the loop ignores it,
  and the wait ends on the timeout, now with the log lines.
- [On Windows, the user cannot see the data as a directory] → This is the
  usual form for Postgres in a container on Windows. `--delete-data` is the
  supported way to remove it.
- [An older Windows build left a `postgres` directory with a failed `initdb`]
  → Nothing mounts it after this change. `down --delete-data` removes it.

## Migration Plan

No migration. No Windows host holds Postgres data, because `initdb` never
completed on the bind mount. The compose file of each other host does not
change. To roll back, revert the commit. A Windows host then fails again as it
does today, and its named volume stays in the engine until a person removes
it.

## Open Questions

- `capture` in `src/lib/container.ts` has no time limit for one call. The
  report in #561 says that `inflexa` stays in the wait with no end, but the
  code stops after 30 seconds. If `exec` blocks on a container that restarts,
  it defeats the 30 seconds, and it also defeats D6. There is no evidence of
  that today, thus this change does not add a limit. If the reporter sees the
  same symptom after this change, the next step is the `timeout` option of
  `Bun.spawn` on the poll calls.
