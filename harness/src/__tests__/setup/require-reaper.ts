/**
 * The guard that stops the container fallback in `postgres.ts` from leaking a
 * `pgvector/pgvector:pg18` container.
 *
 * The memoized promise in `postgres.ts` lives in the module state of one Bun
 * module registry, so the fallback starts one container for each registry that
 * runs a database test file: one for a default `bun test`; one for each
 * database test file under `--isolate` or `--parallel`; one for each worker
 * that runs a database test file under `--parallel --no-isolate`. Removing
 * them is left entirely to the `ryuk` sidecar. On a rootful podman machine
 * ryuk starts only when it runs privileged, because SELinux in the VM blocks
 * the runtime socket for an unprivileged ryuk; the guard sets that default.
 * Where ryuk cannot start, the container of a bare `bun test` would stay with
 * nothing to remove it.
 *
 * So the fallback asks, BEFORE it starts anything, whether a reaper will
 * actually remove what it is about to start. `getReaper()` is testcontainers'
 * own bootstrap — the very call `GenericContainer.start()` makes — so asking it
 * here is an exact answer rather than a guess about the runtime, and it costs
 * nothing: the reaper it starts is the one the container start would have
 * started, memoized. If it cannot come up, no container is created.
 *
 * WHY THE GUARD LIVES HERE, at the point of container creation, and not in a
 * `pretest` script or a `bunfig.toml` [test].preload:
 *
 *  - `bun test` does not run `pretest`. Lifecycle scripts fire for `bun run
 *    <script>`; the bare `bun test` this is meant to catch never reaches them,
 *    and `harness` has no `test` script to hang one off.
 *  - Bun resolves bunfig from the cwd and never walks up (the monorepo-root
 *    bunfig.toml documents this), so a preload guard is silently absent for
 *    `cd harness/src/state && bun test`. The root bunfig names the library-level
 *    check as the structural backstop for exactly that bypass; this is the
 *    harness's.
 *  - A run-level guard cannot know whether the run will touch Postgres, so it
 *    would have to refuse a unit-only run that starts no container at all.
 *    Placed on the creation path, the guard is met only by a file that is
 *    actually about to start one — a unit file never reaches it, and needs no
 *    exemption.
 */

import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { getContainerRuntimeClient, getReaper } from "testcontainers";

/** testcontainers' own switch: "true" swaps the real reaper for a no-op stand-in. */
const RYUK_DISABLED_ENV = "TESTCONTAINERS_RYUK_DISABLED";
/** testcontainers reads this lazily, when `getReaper` makes a new ryuk. */
const RYUK_PRIVILEGED_ENV = "TESTCONTAINERS_RYUK_PRIVILEGED";

const ROUTES = `Use one of the two routes that start ONE container for the whole run:

  bun run test:full [paths...]     starts one container, exports CORTEX_TEST_PG_URL, removes it on exit
  CORTEX_TEST_PG_URL=postgres://cortex:dev@localhost:5433/cortex bun test [paths...]
                                   points every file at a Postgres that already runs; starts nothing

Unset ${RYUK_DISABLED_ENV} if it is set. If ryuk cannot start, check these:

  DOCKER_HOST=unix://<socket>      when /var/run/docker.sock does not reach your container machine
  ${RYUK_PRIVILEGED_ENV}=true
                                   when SELinux in a podman VM blocks the runtime socket for ryuk
                                   (this guard sets it when it is absent from the environment)
  TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=<path>
                                   when the runtime socket inside the VM is not at /var/run/docker.sock,
                                   for example on a rootless podman machine`;

/**
 * The refusal a developer reads. It names what is missing and both safe routes,
 * because the message is the only place this is explained at the moment it
 * matters.
 */
export function refusalMessage(reason: string): string {
    return `Refusing to start a Postgres testcontainer: ${reason}, so nothing would remove it.

This fallback starts one container for a default run, one for each database test file under
--isolate or --parallel, and one for each worker that runs a database test file under
--parallel --no-isolate. Without a reaper, each of those outlives the run.

${ROUTES}`;
}

/**
 * Make ryuk run privileged unless the developer chose a value. The empty value
 * counts as a choice.
 */
export function defaultRyukPrivileged(env: NodeJS.ProcessEnv): void {
    if (env[RYUK_PRIVILEGED_ENV] === undefined) env[RYUK_PRIVILEGED_ENV] = "true";
}

/**
 * Throw unless the container this fallback is about to start will be removed
 * again. Called by `startContainer()` only when `CORTEX_TEST_PG_URL` is unset,
 * i.e. only when a container is actually about to be created.
 */
export async function assertContainerWillBeReaped(): Promise<void> {
    // Checked here as well as inside getReaper: with ryuk disabled getReaper
    // hands back a no-op reaper rather than throwing, so the container would
    // start and never be removed — the exact leak this guard exists to stop.
    if (process.env[RYUK_DISABLED_ENV] === "true") {
        throw new Error(refusalMessage(`${RYUK_DISABLED_ENV}=true disables the ryuk reaper`));
    }

    defaultRyukPrivileged(process.env);

    let client;
    try {
        client = await getContainerRuntimeClient();
    } catch (err) {
        throw new Error(refusalMessage(`no container runtime is reachable (${describe(err)})`), { cause: err });
    }

    let reaper;
    try {
        reaper = await getReaper(client);
    } catch (err) {
        throw new Error(refusalMessage(`the ryuk reaper could not be started (${describe(err)})`), { cause: err });
    }

    // Unreachable against testcontainers as it stands: the only reaper with an
    // empty containerId is its DisabledReaper, and that is returned only under
    // `RYUK_DISABLED_ENV === "true"`, which the check above already refuses. Kept
    // as a backstop, so that a future upstream reaper that comes up with no
    // container behind it cannot reopen the leak silently.
    if (!reaper.containerId) {
        throw new Error(refusalMessage("the ryuk reaper is not running"));
    }
}

function describe(err: unknown): string {
    return errorMessageOf(err) ?? textOf(err);
}
