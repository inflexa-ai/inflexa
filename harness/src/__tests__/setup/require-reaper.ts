/**
 * The guard that stops the container fallback in `postgres.ts` from leaking a
 * `pgvector/pgvector:pg18` container for each database test file.
 *
 * Bun isolates module state per test file, so the memoized promise in
 * `postgres.ts` is NOT shared across test files — on the fallback path each DB
 * file starts its OWN container. Removing them is left entirely to the
 * `ryuk` sidecar, and ryuk does not come up under podman (see CLAUDE.md). Where
 * that holds, a bare `bun test` ends with one standing container for each DB
 * file and nothing to remove them.
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

import { getContainerRuntimeClient, getReaper } from "testcontainers";

/** Set to any non-empty value to accept the leak and start the container anyway. */
const ALLOW_LEAK_ENV = "CORTEX_TEST_ALLOW_LEAKED_PG";

const ROUTES = `Use one of the two routes that start ONE container for the whole run:

  bun run test:full [paths...]     starts one container, exports CORTEX_TEST_PG_URL, removes it on exit
  CORTEX_TEST_PG_URL=postgres://cortex:dev@localhost:5433/cortex bun test [paths...]
                                   points every file at a Postgres that already runs; starts nothing

Set ${ALLOW_LEAK_ENV}=1 to start the container regardless, accepting one
unreaped container for each database test file.`;

/**
 * The refusal a developer reads. It names what is missing and both safe routes,
 * because the message is the only place this is explained at the moment it
 * matters.
 */
export function refusalMessage(reason: string): string {
    return `Refusing to start a Postgres testcontainer: ${reason}, so nothing would remove it.

Bun gives each test file its own module state, so this fallback starts one container per database
test file, and without a reaper every one of those outlives the run.

${ROUTES}`;
}

/**
 * Throw unless the container this fallback is about to start will be removed
 * again. Called by `startContainer()` only when `CORTEX_TEST_PG_URL` is unset,
 * i.e. only when a container is actually about to be created.
 */
export async function assertContainerWillBeReaped(): Promise<void> {
    if (process.env[ALLOW_LEAK_ENV]) return;

    // Checked here as well as inside getReaper: with ryuk disabled getReaper
    // hands back a no-op reaper rather than throwing, so the container would
    // start and never be removed — the exact leak this guard exists to stop.
    if (process.env.TESTCONTAINERS_RYUK_DISABLED === "true") {
        throw new Error(refusalMessage("TESTCONTAINERS_RYUK_DISABLED=true disables the ryuk reaper"));
    }

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

    // A reaper with no container behind it is testcontainers' disabled stand-in.
    if (!reaper.containerId) {
        throw new Error(refusalMessage("the ryuk reaper is not running"));
    }
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
