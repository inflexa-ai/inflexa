## 1. The guard

- [x] 1.1 Remove `CORTEX_TEST_ALLOW_LEAKED_PG` and its early return from `src/__tests__/setup/require-reaper.ts`, and keep the refusal on `TESTCONTAINERS_RYUK_DISABLED=true`. Done when `grep -rn CORTEX_TEST_ALLOW_LEAKED_PG src scripts` finds matches only in `src/__tests__/setup/require-reaper.test.ts`
- [x] 1.2 Add one exported function in `require-reaper.ts` that sets `TESTCONTAINERS_RYUK_PRIVILEGED=true` in a given environment when the variable is unset and keeps a set value. Call it from `assertContainerWillBeReaped` with `process.env`, after the disabled check and before `getReaper`. Done when the tests of 2.2 pass
- [x] 1.3 Replace the accept-the-leak text of the refusal with the podman variables: unset `TESTCONTAINERS_RYUK_DISABLED`, then `DOCKER_HOST`, `TESTCONTAINERS_RYUK_PRIVILEGED=true`, and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`, each with its condition. Keep both routes that start one container for the run. Done when the tests of 2.3 pass
- [x] 1.4 Correct the header comment of `require-reaper.ts`: ryuk starts on a rootful podman machine when it runs privileged, and the guard sets that default. Done when no comment in `src/__tests__/setup` says that ryuk does not start under podman

## 2. Tests

- [x] 2.1 In `src/__tests__/setup/require-reaper.test.ts`, make the disabled-ryuk test also set `CORTEX_TEST_ALLOW_LEAKED_PG=1` and expect the refusal. Remove the accept-the-leak test. Done when the test passes
- [x] 2.2 Add tests for the function of 1.2: an unset variable becomes `true`, and a set value (`false`) stays. Done when the tests pass and start no container
- [x] 2.3 Replace the message test of the accept-the-leak variables: the refusal names `DOCKER_HOST`, `TESTCONTAINERS_RYUK_PRIVILEGED=true`, and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`, and it does not contain `CORTEX_TEST_ALLOW_LEAKED_PG`. Done when `bun test src/__tests__/setup/require-reaper.test.ts` passes

## 3. The script and the documents

- [x] 3.1 In `scripts/test-full.sh`, make a container name from the process id and a random value. Set the `EXIT` trap on that name before `docker run`, and pass `--name` to `docker run`. Keep `--rm` and `rm -f -v`. Done when `bash -n scripts/test-full.sh` passes
- [x] 3.2 In the Testing section of `CLAUDE.md`, remove the last-resort route and correct the podman text. State the privileged default, and the socket override for a rootless machine. State that ryuk removes the containers of a plain `bun test`, and their volumes, after the run. Correct the `bun test` comment in the Commands section ("Unit tests only") to the same fact. Do not state how many containers a plain run starts Done when `grep -n CORTEX_TEST_ALLOW_LEAKED_PG CLAUDE.md` finds nothing
- [x] 3.3 Run `bun run typecheck`, `bun run lint` on the changed files, and `bun run format:file` on the changed files in `src/`. Done when all are clean
- [x] 3.4 Run the full suite one time with `bun run test:full`. Done when it passes. After the run, `docker ps -a` and `podman ps -a` must show no container from the run, because the script uses whichever runtime the `docker` CLI reaches

## 4. Acceptance on podman (the coordinator runs it)

- [x] 4.1 With `CORTEX_TEST_PG_URL` and the testcontainers variables unset, run `bun test` on one database test file on the rootful podman machine. Done when ryuk starts and the file passes. After 60 seconds, `podman ps -a --filter label=org.testcontainers=true` must be empty, and `podman volume ls -f dangling=true` must show no new volume
- [x] 4.2 Start `bun run test:full src/__tests__/setup` in the background, wait until its `cortex-test-pg-` container exists, and send SIGINT to the script. Done when the container and its anonymous volume are gone from the runtime that the `docker` CLI reaches
- [x] 4.3 With `DOCKER_HOST` at the Docker Desktop socket and `CORTEX_TEST_PG_URL` unset, run `bun test` on one database test file. Done when ryuk starts and the file passes. After 60 seconds, `docker ps -a --filter label=org.testcontainers=true` must be empty, and `docker volume ls -f dangling=true` must show no new volume
