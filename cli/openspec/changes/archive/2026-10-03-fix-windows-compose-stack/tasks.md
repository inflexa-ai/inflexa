## 1. The host seam and the location of the Postgres data

- [x] 1.1 In `src/modules/infra/compose.ts`, add the exported type `ComposeHost` with `platform`, `cliproxyConfigPath`, `cliproxyAuthDir`, and `postgresDataDir`. Give it a JSDoc block that gives the reason of design D3.
- [x] 1.2 In the same file, add a module constant for the real host. It reads `process.platform` and the three paths of `env`.
- [x] 1.3 In the same file, add the exported constant `POSTGRES_VOLUME_NAME`, which is `${PREFIX}-postgres-data`. Put the reason for the explicit name of design D4 in its JSDoc block.
- [x] 1.4 In the same file, add the exported type `PostgresDataLocation` and the exported function `postgresDataLocation(host)`, with the real host as the default. It gives `volume` for `win32`, and `bind` for each other platform. Put the reason for the platform key of design D2 in its JSDoc block.

## 2. The compose template

- [x] 2.1 Give `generateComposeFile` an optional third parameter `host: ComposeHost`, with the real host as the default. Read the three host paths from `host`, not from `env`.
- [x] 2.2 Wrap each of the three host paths in `escapeYaml`.
- [x] 2.3 Write the volume line of the Postgres service from `postgresDataLocation(host)`. For `volume`, also write the top-level `volumes:` block, with `name: ${POSTGRES_VOLUME_NAME}`. For `bind`, the output must be the same as it is today.
- [x] 2.4 Put a comment at the volume line that says why a Windows host gets a named volume. Do not write the history of the change.

## 3. The mount manifest and the guard

- [x] 3.1 Give `mountManifest` an optional second parameter `host: ComposeHost`, with the real host as the default. Read the paths from `host`. Add the Postgres data directory only when `postgresDataLocation(host)` is `bind`.
- [x] 3.2 Give `ensureMountSources` the same optional parameter, and give it to `mountManifest`. `composeUp` keeps the default.
- [x] 3.3 Update the JSDoc block of `mountManifest`: a named volume is not a mount source.

## 4. `inflexa down --delete-data`

- [x] 4.1 In `src/modules/infra/compose.ts`, add the exported function `removePostgresVolume(rt)` of design D5. It runs `volume inspect`, and it gives `ok("absent")` on a non-zero exit. Then it runs `volume rm`, and it gives the `volume_remove_failed` error with the stderr text on a non-zero exit.
- [x] 4.2 In `down` of `src/modules/infra/lifecycle.ts`, call `removePostgresVolume(rt)` inside the `deleteData` branch, after `composeDown`. On `removed`, print one line. On `absent`, print nothing. On an error, print a warning with the message, and continue. Keep the two `rmSync` calls as they are.
- [x] 4.3 In `confirmDeleteData`, name the location from `postgresDataLocation()`: the data directory for `bind`, and the volume for `volume`.
- [x] 4.4 Do not add a command or an option. Thus no `AgentPolicy` question comes from this change.

## 5. The readiness wait

- [x] 5.1 In `src/modules/infra/postgres_types.ts`, add `{ type: "container_crash_loop"; message: string }` to `PostgresError`. Put a comment above it, the same as `mount_source_unavailable` has.
- [x] 5.2 In `src/modules/infra/postgres.ts`, add a function that reads the restart count with `inspect --format {{.RestartCount}}`. It gives `number | null`. A non-zero exit gives `null`, and text that is not a whole number gives `null`.
- [x] 5.3 In the same file, add a function that reads `logs --tail 20` of the container. It joins stdout and stderr, and it gives an empty string when the call fails.
- [x] 5.4 In `waitForReady`, read the restart count after each failed `pg_isready`. Keep the first good read as the baseline. When a later read is 2 or more above the baseline, give `container_crash_loop` at once.
- [x] 5.5 Put the log lines into the message of `container_crash_loop` and into the message of `ready_timeout`. Each message keeps the command for the full log. When the log text is empty, omit the lines.
- [x] 5.6 Update the JSDoc block of `waitForReady` with the three reasons of design D6: the count and not the status, a rise and not a value, and a rise of 2.

## 6. The help row

- [x] 6.1 In the path registry of `src/lib/env.ts`, make the description of `postgresDataDir` a conditional on `process.platform`. On `win32`, say that the directory is not in use, and that a named volume of the container engine holds the data.

## 7. The tests

- [x] 7.1 In `src/modules/infra/compose.test.ts`, add a Windows `ComposeHost` fixture with backslash paths. Add a POSIX fixture with a `"` in its paths, because that character is not legal in a Windows path.
- [x] 7.2 In that file, change `bindMountHosts`. Split the scalar at the last `:` that comes before the container path. Remove the YAML escape. Keep a host that starts with `/`, and keep a host that starts with a drive letter.
- [x] 7.3 Assert that the Windows fixture gives volume lines with each backslash doubled. Assert that the POSIX fixture gives the `"` escaped. Assert that the helper of 7.2 reads each exact path back.
- [x] 7.4 Assert that the default host gives the same three volume lines as before the escape, as literal strings.
- [x] 7.5 Assert the named volume for the Windows fixture, in the two modes. The Postgres service mounts `POSTGRES_VOLUME_NAME`. The top-level `volumes:` block has the `name:` line. No line holds the Postgres data directory.
- [x] 7.6 Assert that a `darwin` host and a `linux` host give no top-level `volumes:` block.
- [x] 7.7 Run the manifest-coverage test for the Windows fixture also. Assert that its `direct` manifest is empty. Assert that its `cliproxy` manifest lists only the config file and the credential directory.
- [x] 7.8 Assert that `ensureMountSources("direct", windowsHost)` makes no directory.
- [x] 7.9 Do a test of `removePostgresVolume` with a spy on `container.capture`. A non-zero `volume inspect` gives `absent`, and no `volume rm` runs. Two zero exits give `removed`. A non-zero `volume rm` gives the error with the stderr text.
- [x] 7.10 In `src/modules/infra/postgres.test.ts`, test `waitForReady` with a spy on `container.capture` and a spy on `Promise.sleep`. Cover the four scenarios of the new requirement in the `postgres-provisioning` delta.
- [x] 7.11 `down` has no test today, and its prompt is interactive. Do not add one. The tests of 7.9 and of `postgresDataLocation` cover the new parts.

## 8. Verification

- [x] 8.1 Run `bun run typecheck` in `cli/`.
- [x] 8.2 Run `bun run lint` in `cli/`.
- [x] 8.3 Run `bun run test src/modules/infra/compose.test.ts src/modules/infra/postgres.test.ts src/lib/env.test.ts` in `cli/`.
- [x] 8.4 Run `bun run format:file` on each file in `src/` that changed.
- [x] 8.5 Run `openspec validate fix-windows-compose-stack --strict` in `cli/`.
