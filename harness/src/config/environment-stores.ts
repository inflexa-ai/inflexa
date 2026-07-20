/**
 * The two host paths that describe what an analysis environment can actually do:
 * the reference data staged for it, and the packages installed in its sandbox.
 *
 * They are declared once, here, because every agent-facing deps bag that carries
 * them means the same thing by them — and when each bag documented them itself,
 * the prose drifted per site (the same field explained in terms of "the executor",
 * "the profiler", "the planner") while the contract stayed identical. Extending
 * this interface keeps one description of a field that has one meaning.
 */

/**
 * Host paths of the environment's two read-only stores.
 *
 * Both are HOST paths, deliberately: reading them host-side is what lets the
 * conversation agent and the planner answer "what does this environment hold?"
 * before any sandbox exists, and they are the same bytes a sandbox agent sees
 * through its mounts — so every agent gets one answer rather than a per-vantage
 * one. Neither store is ever written through these paths.
 *
 * Both are optional, and absence is a NORMAL state rather than an error: an
 * omitted path makes its tool report the store as unavailable or unknown, which
 * is a truthful answer an agent can act on. Absence must never be reported as a
 * failure, and never papered over with a guessed path.
 */
export interface EnvironmentStorePaths {
    /**
     * Host path of the reference store — the same bytes sandboxes mount at
     * `/mnt/refs`. Omit when no store is provisioned; reference discovery then
     * reports the store as unavailable. Note that an installed store reads as
     * absent if this is omitted, which is indistinguishable to an agent from
     * having no data — so omit it only when there is genuinely nothing staged.
     */
    readonly refStorePath?: string;
    /**
     * Host path of the library store's `packages.txt` — the inventory of what is
     * importable inside a sandbox. Omit when the host mounts the store at the
     * sandbox's own path, which makes the container path correct as-is; a host
     * whose store is baked into the image and never bind-mounted must inject the
     * path to its own extracted copy, or the inventory reads as unknown.
     */
    readonly packagesFile?: string;
}
