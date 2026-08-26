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
 * omitted path falls back to the store's container mountpoint — correct for a
 * host whose own process sees the store the way a sandbox does, and harmless for
 * one that does not, because every consumer stats the root before it reports
 * anything. A host with nothing mounted there gets the same "unavailable" or
 * "unknown" answer an omitted path has always produced, so the fallback can no
 * more invent a store than an explicit path can. Set a path only to name a
 * location the container mountpoint does not describe; absence must never be
 * reported as a failure.
 */
export interface EnvironmentStorePaths {
    /**
     * Host path of the reference store — the same bytes sandboxes mount at
     * `/mnt/refs`. Omit when the host's own process sees the store at that same
     * path, as a K8s pod holding the ref-store PVC does; set it when the host
     * reads the store somewhere else, as a native process bind-mounting a host
     * directory into Docker does.
     */
    readonly refStorePath?: string;
    /**
     * Host path of the `inflexa.lock` of the farm — the inventory of what is
     * importable inside a sandbox. Omit when the host mounts the farm at the
     * sandbox's own path, which makes the container path correct as-is; a host
     * that reads the farm somewhere else must inject the path, or the
     * inventory reads as unknown.
     */
    readonly farmLockFile?: string;
    /**
     * Host path of the baked image inventory fragment
     * (`image-packages.txt`) — the image-owned tools that
     * `list_available_packages` merges into its report. Omit when the host
     * cannot read one; a missing fragment merges nothing, and that is a
     * normal state.
     */
    readonly imagePackagesFile?: string;
    /**
     * The pool-scope inventory of the package store: every package the pool
     * holds, whether or not a farm links it yet. Bind it for a conversation
     * or planning surface — the ask flow marks the packages that the POOL
     * does not hold, and the farm of a new analysis is empty, which would
     * read as "everything is absent". Leave it unbound for a sandbox agent,
     * because a step imports only what its farm links. An `unavailable` read
     * carries the reason of the embedder — a damaged dependency graph reads
     * as unavailable WITH its cause, never as an empty pool, because the
     * cause is what tells the agent the state is structural and not
     * transient.
     */
    readonly readPoolInventory?: () => Promise<PoolInventoryRead>;
}

/**
 * What one pool-scope inventory read produced: the sections, or the reason
 * the pool cannot answer. There is no empty-on-error shape — an unreadable
 * pool must stay distinguishable from a pool that holds nothing.
 */
export type PoolInventoryRead =
    { readonly kind: "sections"; readonly sections: readonly PoolInventorySection[] } | { readonly kind: "unavailable"; readonly reason: string };

/** One package entry of an inventory section, with the store identity where the source records it. */
export interface PoolInventoryPackage {
    readonly name: string;
    /** The pinned version, rendered as `name==version`. Absent for an image-fragment tool. */
    readonly version?: string;
    /** The content-addressed store directory of the package. */
    readonly storeDir?: string;
    /** The full sha256 of the sorted store tree. */
    readonly hash?: string;
}

/** One language-track section of an inventory, as `list_available_packages` renders it. */
export interface PoolInventorySection {
    readonly title: string;
    readonly packages: readonly PoolInventoryPackage[];
}
