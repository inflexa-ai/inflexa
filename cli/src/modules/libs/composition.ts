/**
 * Host-side composition of the per-analysis package farm.
 *
 * The store on disk is one content-addressed pool (`store/`), one farm for each
 * analysis (`farms/<analysisId>`), and one resolved dependency graph at the store
 * root (`deps.json`). A farm is a tree of symbolic links into the pool. Thus the
 * composition of a farm installs nothing, it starts no container, and it opens no
 * network connection: it reads the graph, it takes the closure of the requested
 * roots, and it writes links.
 *
 * The provisioner image builds a farm the same way (`images/sandbox-provisioner/
 * provision.py`, `link_tree`, `build_farm`, and `build_r_farm`). Two builders of
 * one layout is a real risk, thus `composition.test.ts` holds a golden-fixture
 * parity test that composes one fixture pool with both builders and compares the
 * two trees.
 *
 * **The two path spaces.** A farm link bakes an ABSOLUTE target under
 * {@link SANDBOX_LIB_MOUNT}, because the sandbox resolves the link at its own
 * mount and the provisioner bakes the same path. The host store root is somewhere
 * else (`env.libStoreDir`), thus the composer cannot stat a baked path. It carries
 * the two paths side by side: the host path for each filesystem question, and the
 * baked path for the text that it writes into the link.
 *
 * **The plan and the apply.** The link pass runs in two steps. The first step
 * plans the operations against an overlay of the farm, and it writes nothing. The
 * second step replays the plan. Thus a version collision refuses with the farm
 * exactly as it was, and an extension can prove that it touches no existing link.
 */

import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { acquireInstanceLock, instanceLockHolder, releaseInstanceLock, LIB_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { type FsError, readFileResult, writeFileResult } from "../../lib/fs.ts";

// --- The store layout ---------------------------------------------------------

/** The content-addressed pool, under the store root. */
const POOL_DIR = "store";

/** The farms, under the store root. One farm for each analysis, plus the template. */
const FARMS_DIR = "farms";

/** The sandbox leases, under the store root. The provisioner writes one file for each live sandbox. */
const LEASES_DIR = "leases";

/** The resolved dependency graph, at the store root. `emit_deps.py` publishes it. */
const GRAPH_NAME = "deps.json";

/** The schema version of the graph that this reader understands. */
const GRAPH_VERSION = 1;

/**
 * The farm that the published catalog brings. It is the TEMPLATE, never an
 * environment: composition reads its lock for the default roots, and it links its
 * warm caches into each analysis farm.
 *
 * `store.ts` holds the same name for its inspection. The two cannot share one
 * declaration without a change to that file, which a different concern owns.
 */
const CATALOG_FARM = "catalog";

/**
 * The path the sandbox mounts the store root at, read-only. A farm link bakes an
 * absolute target beneath it, exactly as `provision.py` does, because the link
 * text must resolve inside the sandbox and not on the host.
 */
const SANDBOX_LIB_MOUNT = "/mnt/libs";

/**
 * The entries of a store directory that are records of the store, not content. The
 * provisioner skips the same three names when it links a store directory.
 */
const NOT_CONTENT: ReadonlySet<string> = new Set([".inflexa-pin", ".inflexa-r-linking", ".lock"]);

/** The three R library subtrees that `R_LIBS_SITE` carries, in the order the provisioner uses. */
const R_SUBTREES = ["cran", "bioconductor", "github"] as const;

/** One of the three R library subtrees. */
type RSubtree = (typeof R_SUBTREES)[number];

/** The two runtime tracks of the store, in the order that a request searches them. */
const TRACKS = ["python", "r"] as const;

/** One of the two runtime tracks. */
type Track = (typeof TRACKS)[number];

/**
 * The prepared cache directories of the catalog template. Composition LINKS them
 * into each analysis farm, and it never copies them. A cache entry that does not
 * match the package version of a farm misses and recompiles, which is safe.
 */
const WARM_CACHE_DIRS = ["numba-cache", "matplotlib_config"] as const;

/** The farm record that the composer writes and reads again on an extension. */
const FARM_LOCK = "lock.json";

/** The first of the two completeness markers that the harness usability gate requires. */
const FARM_INVENTORY = "packages.txt";

/** The second of the two completeness markers that the harness usability gate requires. */
const FARM_METADATA = "meta.json";

// --- The shared inventory producer -------------------------------------------
// `images/sandbox-base/inflexa-libs-refresh` derives `packages.txt` from one
// fragment for each track. The header, the section titles, and the concatenation
// order are part of the store contract, because the harness parses the result.
// Thus the three tables below are byte-copies of that producer.

/** The advisory header of `packages.txt`, byte-identical to the shared producer. */
export const INVENTORY_HEADER =
    "# Available packages in the sandbox environment.\n" +
    "# You cannot install packages from inside the sandbox (no network, read-only store); adding one is a host action, applied to a later sandbox.\n" +
    "\n";

/** The concatenation order of the track fragments: the R triple first, then Python. */
export const INVENTORY_ORDER = ["cran", "bioconductor", "github", "python"] as const;

/** The fragment file name and the section title of each track that the composer writes. */
export const INVENTORY_TRACKS: Readonly<Record<(typeof INVENTORY_ORDER)[number], { readonly fragment: string; readonly title: string }>> = {
    cran: { fragment: "cran.packages.txt", title: "R (CRAN)" },
    bioconductor: { fragment: "bioconductor.packages.txt", title: "R (Bioconductor)" },
    github: { fragment: "github.packages.txt", title: "R (GitHub)" },
    python: { fragment: "python.packages.txt", title: "Python (pip)" },
};

/** The distribution name that a `.dist-info` directory name records. The shared producer uses this rule. */
const DIST_INFO_NAME = /^(.+?)-[^-]+\.dist-info$/;

/** The canonical name and the version that a store directory name records: `<canon-name>-<version>-<digest>`. */
const STORE_DIR_NAME = /^(.+)-([^-]+)-[0-9a-f]{16}$/;

/**
 * The form that a distribution request takes: `name`, or `name==version`.
 *
 * `==` is the ONE operator that the pool can answer. The pool holds resolved
 * versions, thus a range would ask the host to compare two version strings, and
 * neither ecosystem uses semantic versioning. Any other operator refuses.
 */
const DISTRIBUTION_REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*?)\s*(?:==\s*([^\s=<>!~][^\s]*))?$/;

// --- The two locks of a composition -------------------------------------------
//
// A composition meets two different locks, and each one protects a different thing.
//
// The PER-FARM MUTEX (`farm-<analysisId>`) protects one farm against a second
// writer of that same farm. It is also the liveness record of the composition,
// because a reclamation reads the live holders of this key family and waits for
// them.
//
// The RECLAMATION LOCK ({@link LIB_STORE_RECLAIM_LOCK_KEY}) protects the POOL. A
// reclamation holds it for its whole run, and it frees a store directory that a
// walk of the graph can already name.
//
// The ORDER is fixed, and the fixed order is what prevents a deadlock. A
// reclamation takes the reclamation lock FIRST, and it takes a farm key later,
// inside its orphan-farm reaper. A composition waits for the reclamation lock while
// it holds NO farm key, and a reclamation that starts under the key makes it release
// that key and wait again. Thus no party holds one lock and waits for the other, and
// there is no cycle.

/**
 * The prefix of the instance-lock key of one farm. The analysis id follows it, and
 * that id is a UUIDv7, thus the key collides with no sentinel key.
 *
 * A reclamation reads the live holders of this key family, because that is the
 * liveness record of a composition and the reclamation cannot name the analysis ids
 * itself.
 */
export const FARM_LOCK_KEY_PREFIX = "farm-";

/** How long to wait between two attempts on the per-farm lock. */
const FARM_MUTEX_POLL_MS = 25;

/** How long to wait for the per-farm lock before the composition refuses. Composition costs milliseconds, thus a live holder that outlasts this is stuck. */
const FARM_MUTEX_WAIT_MS = 30_000;

/** How long to wait between two reads of the reclamation lock. It is the cadence an acquisition flight uses for the same lock. */
const RECLAIM_POLL_MS = 250;

/** How long a composition yields to a live reclamation before it refuses. It is the wait an acquisition flight gives the same lock. */
const RECLAIM_WAIT_MS = 120_000;

/**
 * The tail of the in-process work of each farm key.
 *
 * {@link acquireInstanceLock} is re-entrant for the pid that holds the lock, thus
 * the lock file alone does NOT serialize two compositions inside one process. This
 * chain does. The lock file serializes the compositions across two processes.
 */
const farmQueue = new Map<string, Promise<unknown>>();

/** The two waits of the yield to a reclamation, which a test shortens. */
type ReclaimYield = { readonly waitMs: number; readonly pollMs: number };

// --- The graph ----------------------------------------------------------------

const depsNodeSchema = z.object({
    track: z.enum(["python", "r"]),
    imports: z.array(z.string()).default([]),
    entry_points: z.array(z.string()).default([]),
    edges: z.array(z.string()).default([]),
    r_dir: z.string().optional(),
});

/** The store directories of each distribution name of one track, newest first. */
const depsPoolSchema = z.record(z.string(), z.array(z.string()));

const depsGraphSchema = z.object({
    version: z.number(),
    nodes: z.record(z.string(), depsNodeSchema),
    by_name: z.object({ python: depsPoolSchema.default({}), r: depsPoolSchema.default({}) }),
});

/**
 * One node of the resolved dependency graph. The key of a node is the name of its
 * store directory, and each edge names another node exactly. The graph holds no
 * version range, because the resolver of the provisioner settled each constraint
 * at build time.
 */
export type DepsNode = {
    /** Which runtime the store directory serves. */
    readonly track: "python" | "r";
    /**
     * The top-level module names that the distribution gives. The link pass reads
     * the tree instead, exactly as the provisioner does, because the tree is the
     * truth about what a link must cover. The field stays parsed for a caller that
     * maps an import failure back onto a package.
     */
    readonly imports: readonly string[];
    /** The command names that the distribution installs. The bin hoist reads the `bin` directory instead, for the same reason. */
    readonly entryPoints: readonly string[];
    /** The store directories that this node depends on. Each one names a node of the graph. */
    readonly edges: readonly string[];
    /** The inner directory of an R store directory, whose name is the real package name. `null` for a Python node. */
    readonly rDir: string | null;
};

/** The resolved dependency graph of the pool, indexed by store-directory name. */
export type DepsGraph = {
    /** The schema version that the emitter published. */
    readonly version: number;
    /** One node for each store directory, keyed by the name of that directory. */
    readonly nodes: ReadonlyMap<string, DepsNode>;
    /**
     * The store directories of each distribution, for each track, keyed by the
     * canonical name and ordered NEWEST FIRST.
     *
     * The EMITTER settles the order, and a release comes before a pre-release of a
     * later version. Neither ecosystem uses semantic versioning, thus a host that
     * compared two version strings would guess. A request that names no version takes
     * the head of the list, and it orders nothing itself.
     */
    readonly byName: Readonly<Record<Track, ReadonlyMap<string, readonly string[]>>>;
};

// --- The errors ---------------------------------------------------------------

/** Why a composition, an extension, or a removal of a farm could not complete. */
export type FarmCompositionError =
    | FsError
    /** The graph is absent, unparsable, or of a version that this reader does not understand. */
    | { readonly type: "graph_unusable"; readonly path: string; readonly detail: string }
    /** The graph names a node that it does not hold. The closure would be short, thus the walk refuses. */
    | { readonly type: "graph_dangling_edge"; readonly edges: readonly { readonly from: string; readonly to: string }[] }
    /** A requested root is not a store directory of the graph. */
    | { readonly type: "unknown_root"; readonly roots: readonly string[] }
    /** The catalog template farm is absent, thus there is no default root set and no warm cache to link. */
    | { readonly type: "template_unusable"; readonly path: string; readonly detail: string }
    /**
     * Two store directories claim one top-level name, and the composer cannot merge
     * them. The farm stays exactly as it was.
     */
    | { readonly type: "version_collision"; readonly name: string; readonly existing: string; readonly incoming: string }
    /** A different process composes this farm right now, and it did not finish inside the wait. */
    | { readonly type: "farm_locked"; readonly analysisId: string; readonly holderPid: number }
    /** A reclamation of the pool runs right now, and it did not finish inside the wait. */
    | { readonly type: "reclaim_in_flight"; readonly analysisId: string; readonly holderPid: number }
    /** A lease records a live sandbox of the farm, thus the removal refuses. */
    | { readonly type: "farm_leased"; readonly analysisId: string; readonly leases: readonly string[] };

/** One line that names why a composition, an extension, or a removal did not complete. */
export function describeFarmCompositionError(error: FarmCompositionError): string {
    switch (error.type) {
        case "io_failed":
            return `could not ${error.op} (${error.cause instanceof Error ? error.cause.message : String(error.cause)})`;
        case "graph_unusable":
            return `the dependency graph at ${error.path} is unusable: ${error.detail}`;
        case "graph_dangling_edge":
            return `the dependency graph names ${error.edges.length} edge(s) that it does not hold, for example ${error.edges[0]?.from} to ${error.edges[0]?.to}`;
        case "unknown_root":
            return `the dependency graph holds no store directory named ${error.roots.join(", ")}`;
        case "template_unusable":
            return error.detail;
        case "version_collision":
            return `two store directories claim the name "${error.name}": ${error.existing} and ${error.incoming}`;
        case "farm_locked":
            return `another process (pid ${error.holderPid}) composes this farm right now`;
        case "reclaim_in_flight":
            return `a package-store reclamation (pid ${error.holderPid}) runs right now, and it frees the pool content that this farm would link`;
        case "farm_leased":
            return `${error.leases.length} sandbox lease(s) hold this farm (${error.leases.slice(0, 3).join(", ")})`;
        default: {
            // The union is closed, thus the compiler proves that this is unreachable.
            const unreachable: never = error;
            throw new Error(`unhandled farm composition error: ${JSON.stringify(unreachable)}`);
        }
    }
}

/**
 * The composition failure that a reader has not reported yet.
 *
 * The farm provider makes a farm INSIDE the harness, thus it runs after the sandbox
 * gate decided and the user never meets the error type. This holder is the channel
 * back: {@link makeEmptyFarm} records a failure here, and the gate names it at the
 * next sandbox action. The direction is the only one the layering permits, because a
 * module must never import the presentation layer.
 */
let pendingFailure: FarmCompositionFailure | null = null;

/** Why the last composition of one farm did not complete, as the sandbox gate reports it. */
export type FarmCompositionFailure = {
    /** The analysis whose farm could not be composed. */
    readonly analysisId: string;
    /** The one-line reason, from {@link describeFarmCompositionError}. */
    readonly reason: string;
};

/**
 * Read the composition failure that nothing reported yet, and clear it.
 *
 * The read CONSUMES, deliberately. A gate that held the record would refuse every
 * later action on a verdict that a store download or a package acquisition can have
 * fixed, and no later composition could clear it, because the gate itself is what
 * stops that composition from running.
 */
export function takeFarmCompositionFailure(): FarmCompositionFailure | null {
    const failure = pendingFailure;
    pendingFailure = null;
    return failure;
}

// --- The results --------------------------------------------------------------

/** What a composition or an extension of a farm produced. */
export type FarmComposition = {
    /** The farm on the host, at `<storeRoot>/farms/<analysisId>`. */
    readonly farmPath: string;
    /** The store directories that the caller asked for, which are the roots of the walk. */
    readonly roots: readonly string[];
    /** The whole closure of the roots, which is what the farm links. */
    readonly storeDirs: readonly string[];
    /** The store directories that THIS call linked. Empty when the farm already held the whole closure. */
    readonly added: readonly string[];
    /** The tracks that the farm carries, which is what its `meta.json` records. */
    readonly tracks: readonly string[];
};

/** What the removal of a farm did. */
export type FarmRemoval = {
    /** The farm that the removal named. */
    readonly farmPath: string;
    /** False when there was no farm to remove, which is a normal state and not an error. */
    readonly removed: boolean;
};

// --- The parameters -----------------------------------------------------------

/** What an extension of a farm needs. */
export type ExtendFarmParams = {
    /** The store root that the CLI owns, which is `env.libStoreDir`. */
    readonly storeRoot: string;
    /** The analysis whose farm this is. */
    readonly analysisId: string;
    /** The store directories to add. Their closure joins the closure that the farm already holds. */
    readonly roots: readonly string[];
};

/**
 * The waits that a caller of a composition can shorten. Production passes none, and a
 * test passes both, so that the refusal of a wait costs milliseconds.
 */
export type FarmCompositionDeps = {
    /** How long a composition yields to a live reclamation before it refuses. Default: {@link RECLAIM_WAIT_MS}. */
    readonly reclaimWaitMs?: number;
    /** How long one step of that yield is. Default: {@link RECLAIM_POLL_MS}. */
    readonly reclaimPollMs?: number;
};

/** The yield of a caller that links pool content, from what that caller asked for. */
function reclaimYield(deps: FarmCompositionDeps): ReclaimYield {
    return { waitMs: deps.reclaimWaitMs ?? RECLAIM_WAIT_MS, pollMs: deps.reclaimPollMs ?? RECLAIM_POLL_MS };
}

/** What a removal of a farm needs. */
export type RemoveFarmParams = {
    /** The store root that the CLI owns, which is `env.libStoreDir`. */
    readonly storeRoot: string;
    /** The analysis whose farm the removal takes away. */
    readonly analysisId: string;
};

// --- The graph reader ---------------------------------------------------------

/**
 * Read the resolved dependency graph at the store root, indexed by
 * store-directory name.
 *
 * The reader refuses a graph with a dangling edge. `emit_deps.py` gates the same
 * condition when it publishes, thus a dangling edge here means that two catalogs
 * merged into one incomplete graph, or that a flight died between a pool write and
 * a graph append. Either way the closure of a walk would be short, and a short
 * closure fails at import inside the sandbox, where nothing explains it.
 */
export function readDepsGraph(storeRoot: string): Result<DepsGraph, FarmCompositionError> {
    const path = join(storeRoot, GRAPH_NAME);
    return readFileResult(path, "read the dependency graph").andThen((raw) => {
        const parsed = JSON.parseWith(raw, depsGraphSchema);
        if (parsed === null) {
            return err<DepsGraph, FarmCompositionError>({ type: "graph_unusable", path, detail: "the file is not a dependency graph" });
        }
        if (parsed.version !== GRAPH_VERSION) {
            return err<DepsGraph, FarmCompositionError>({
                type: "graph_unusable",
                path,
                detail: `the graph is version ${parsed.version}, and this reader understands version ${GRAPH_VERSION}`,
            });
        }

        const nodes = new Map<string, DepsNode>();
        for (const [key, node] of Object.entries(parsed.nodes)) {
            nodes.set(key, {
                track: node.track,
                imports: node.imports,
                entryPoints: node.entry_points,
                edges: node.edges,
                rDir: node.r_dir ?? null,
            });
        }

        const dangling: { from: string; to: string }[] = [];
        for (const key of [...nodes.keys()].sort()) {
            for (const edge of nodes.get(key)?.edges ?? []) {
                if (!nodes.has(edge)) dangling.push({ from: key, to: edge });
            }
        }
        if (dangling.length > 0) return err<DepsGraph, FarmCompositionError>({ type: "graph_dangling_edge", edges: dangling });

        const byName = { python: new Map(Object.entries(parsed.by_name.python)), r: new Map(Object.entries(parsed.by_name.r)) };
        return ok<DepsGraph, FarmCompositionError>({ version: parsed.version, nodes, byName });
    });
}

/**
 * The set of store directories that `roots` reach, which is what a farm links.
 *
 * The walk is a lookup and never a resolution: the graph carries resolved edges,
 * thus a root that the graph does not hold is a named error and never a network
 * call. Every unknown root is reported at one time, so a caller fixes them in one
 * pass.
 */
export function closureOf(graph: DepsGraph, roots: readonly string[]): Result<ReadonlySet<string>, FarmCompositionError> {
    const unknown = [...new Set(roots)].filter((root) => !graph.nodes.has(root)).sort();
    if (unknown.length > 0) return err({ type: "unknown_root", roots: unknown });

    const reached = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
        // The `pop` of a non-empty array gives a value, and the loop condition proves
        // that the array is non-empty.
        const key = pending.pop() as string;
        if (reached.has(key)) continue;
        reached.add(key);
        for (const edge of graph.nodes.get(key)?.edges ?? []) {
            if (!reached.has(edge)) pending.push(edge);
        }
    }
    return ok(reached);
}

// --- The request resolution ---------------------------------------------------

/** What a caller asked for: a distribution requirement, or the module name of a failed import. */
export type PackageRequestRef =
    | {
          /** A requirement in the form `name` or `name==version`. */
          readonly kind: "distribution";
          /** The requirement exactly as the caller wrote it. */
          readonly requirement: string;
      }
    | {
          /** The module name that an import inside the sandbox could not find. */
          readonly kind: "import";
          /** The module name exactly as the caller wrote it. */
          readonly module: string;
      };

/** The store directory that answers one request, with the facts a caller reports back. */
export type ResolvedRequest = {
    /** The store directory of the pool, which is a root of a composition. */
    readonly storeDir: string;
    /** The canonical name of the distribution that the store directory holds. */
    readonly name: string;
    /** The resolved version of that distribution. */
    readonly version: string;
    /** Which runtime the distribution serves. */
    readonly track: Track;
};

/** Why the graph answers a request with nothing. */
export type RequestResolutionError =
    | {
          /** No track of the pool holds the name. */
          readonly type: "unknown_distribution";
          /** The request exactly as the caller wrote it. */
          readonly requested: string;
          /** The canonical form of the name that the request named. */
          readonly name: string;
      }
    | {
          /** The pool holds the name, and it holds no such version of it. */
          readonly type: "unknown_version";
          /** The request exactly as the caller wrote it. */
          readonly requested: string;
          /** The canonical form of the name that the request named. */
          readonly name: string;
          /** The version that the request named. */
          readonly version: string;
          /** The versions that the pool does hold, newest first. */
          readonly available: readonly string[];
      }
    | {
          /** No node of the graph gives the module. */
          readonly type: "unknown_import";
          /** The request exactly as the caller wrote it. */
          readonly requested: string;
          /** The module name that the request named. */
          readonly module: string;
      }
    | {
          /** The requirement is not `name` or `name==version`. */
          readonly type: "malformed_requirement";
          /** The request exactly as the caller wrote it. */
          readonly requested: string;
      };

/**
 * The store directory of the pool that answers one package request.
 *
 * `store link` and the farm-extension seam of the harness share this one lookup, thus
 * a package that a person names and a package that a failed import names reach the
 * pool by one rule. The answer is a root of a composition, and the composition takes
 * its closure.
 *
 * The lookup NEVER orders two versions. {@link DepsGraph.byName} arrives newest
 * first, because the emitter has the metadata of each ecosystem and the host does
 * not. Thus a request with no version takes the head of that list.
 *
 * A store directory whose name records no version cannot answer a request, and the
 * search passes over it. Such an entry is a pool record that the provisioner did not
 * mint, thus no request can name its version and a guess would be worse than a miss.
 */
export function resolvePackageRequest(graph: DepsGraph, request: PackageRequestRef): Result<ResolvedRequest, RequestResolutionError> {
    return request.kind === "distribution" ? resolveDistribution(graph, request.requirement) : resolveImport(graph, request.module);
}

/** The store directory that a `name` or `name==version` requirement names, searched over both tracks. */
function resolveDistribution(graph: DepsGraph, requirement: string): Result<ResolvedRequest, RequestResolutionError> {
    const [, spelled, version] = DISTRIBUTION_REQUIREMENT.exec(requirement.trim()) ?? [];
    if (spelled === undefined) return err({ type: "malformed_requirement", requested: requirement });
    const name = canonicalDistributionName(spelled);

    for (const track of TRACKS) {
        const candidates = (graph.byName[track].get(name) ?? []).flatMap((storeDir) => {
            const parts = partsOfStoreDir(storeDir);
            return parts === null ? [] : [{ storeDir, name, version: parts.version, track }];
        });

        const [head] = candidates;
        if (head === undefined) continue;
        if (version === undefined) return ok(head);

        const exact = candidates.find((candidate) => candidate.version === version);
        if (exact === undefined) {
            return err({ type: "unknown_version", requested: requirement, name, version, available: candidates.map((candidate) => candidate.version) });
        }
        return ok(exact);
    }
    return err({ type: "unknown_distribution", requested: requirement, name });
}

/**
 * The store directory that gives one module name.
 *
 * More than one node can give one module: two distributions share a namespace
 * portion, and two versions of one distribution give the same top-level names. The
 * lookup prefers a claimant that heads the pool of its own name, thus a module of a
 * superseded version resolves to the newest. The rest of the order is the sort of the
 * store directories, so one graph always answers one way.
 */
function resolveImport(graph: DepsGraph, module: string): Result<ResolvedRequest, RequestResolutionError> {
    const wanted = module.trim();
    const claimants: ResolvedRequest[] = [];
    for (const [storeDir, node] of graph.nodes) {
        if (!node.imports.includes(wanted)) continue;
        const parts = partsOfStoreDir(storeDir);
        if (parts === null) continue;
        claimants.push({ storeDir, name: canonicalDistributionName(parts.name), version: parts.version, track: node.track });
    }
    claimants.sort((one, two) => one.storeDir.localeCompare(two.storeDir));

    const chosen = claimants.find((claimant) => graph.byName[claimant.track].get(claimant.name)?.[0] === claimant.storeDir) ?? claimants[0];
    return chosen === undefined ? err({ type: "unknown_import", requested: module, module: wanted }) : ok(chosen);
}

// --- The two path spaces ------------------------------------------------------

/** The host path of a baked link target, or the target itself when it names no store mount. */
function hostPathOf(storeRoot: string, baked: string): string {
    const prefix = `${SANDBOX_LIB_MOUNT}/`;
    return baked.startsWith(prefix) ? join(storeRoot, baked.slice(prefix.length)) : baked;
}

/** The baked target of a path inside the pool, which is what a farm link carries. */
function bakedPoolPath(storeDir: string): string {
    return `${SANDBOX_LIB_MOUNT}/${POOL_DIR}/${storeDir}`;
}

/**
 * The store directory that a baked link target belongs to, or `null` when the
 * target names no store directory. `emit_deps.farm_closure` reads a farm with the
 * same rule.
 */
function storeDirOf(baked: string): string | null {
    const at = baked.indexOf(`/${POOL_DIR}/`);
    if (at < 0) return null;
    return baked.slice(at + POOL_DIR.length + 2).split("/")[0] ?? null;
}

/** Whether a host path is a directory. A path that does not resolve is not a directory. */
function isHostDir(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Whether two store directories are two versions of ONE distribution.
 *
 * This is the one condition that a farm cannot express. A farm links one directory
 * for a top-level name, thus two versions of one distribution would shadow each
 * other, and an import would read a version that no lock names.
 *
 * A shared top-level name between two DIFFERENT distributions is a separate thing,
 * and it is common in the real catalog. Two distributions share a namespace portion
 * (`mpl_toolkits`, `sphinxcontrib`), and a wheel that is packaged loosely ships a
 * top-level `tests`, `benchmarks`, or `resources` directory that carries its own
 * `__init__.py`. The published catalog holds each of those three, from two
 * distributions each. A merge is what the provisioner does with them, and what an
 * install into one `site-packages` produces. Thus a refusal there would refuse each
 * farm that links both distributions, which the published catalog makes common.
 */
function isVersionCollision(existingTarget: string, incomingTarget: string): boolean {
    const existingDir = storeDirOf(existingTarget);
    const incomingDir = storeDirOf(incomingTarget);
    if (existingDir === null || incomingDir === null) return false;
    const existing = nameOfStoreDir(existingDir);
    const incoming = nameOfStoreDir(incomingDir);
    return existing !== null && existing === incoming && existingDir !== incomingDir;
}

// --- The link plan ------------------------------------------------------------

/** One filesystem operation of a link plan. The apply pass replays the list in order. */
type LinkOp =
    | { readonly kind: "mkdir"; readonly path: string }
    | { readonly kind: "unlink"; readonly path: string }
    | { readonly kind: "symlink"; readonly path: string; readonly target: string };

/** What a path holds, either on disk or in the plan that is not applied yet. */
type FarmEntry = { readonly kind: "absent" } | { readonly kind: "dir" } | { readonly kind: "link"; readonly target: string } | { readonly kind: "other" };

/** The state of one plan: the operations so far, the overlay of the farm, and the refusal that stopped it. */
type LinkPlan = {
    readonly storeRoot: string;
    readonly ops: LinkOp[];
    /** The planned state of a path that the plan already changed. It shadows the disk. */
    readonly planned: Map<string, FarmEntry>;
    collision: { readonly name: string; readonly existing: string; readonly incoming: string } | null;
    /**
     * A name that two store directories give, where no merge can hold both — one side
     * is a file. The plan keeps the first side, exactly as the provisioner does, and it
     * records the name so the caller can report it.
     */
    readonly keptFirst: string[];
};

/** What a path holds right now, reading the plan overlay before the disk. */
function entryAt(plan: LinkPlan, path: string): FarmEntry {
    const planned = plan.planned.get(path);
    if (planned) return planned;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return { kind: "absent" };
    if (stat.isSymbolicLink()) return { kind: "link", target: readlinkSync(path) };
    if (stat.isDirectory()) return { kind: "dir" };
    return { kind: "other" };
}

/**
 * Record a name where the plan keeps the side that arrived first.
 *
 * It is not a refusal. Two distributions give one name, and one side is a file, thus
 * no merge holds both. The provisioner keeps the first side and logs, and a farm that
 * refused here would refuse a pair that the published catalog holds.
 */
function keepFirst(plan: LinkPlan, name: string, existing: string, incoming: string): void {
    plan.keptFirst.push(`${name}: ${storeDirOf(existing) ?? existing} over ${storeDirOf(incoming) ?? incoming}`);
}

/** Record a refusal. The first one stops the plan, and the farm stays as it was. */
function refuse(plan: LinkPlan, name: string, existing: string, incoming: string): void {
    plan.collision ??= {
        name,
        existing: storeDirOf(existing) ?? existing,
        incoming: storeDirOf(incoming) ?? incoming,
    };
}

/**
 * Plan a link for each top-level entry of one store directory, and merge a shared
 * namespace directory.
 *
 * Two distributions can share a top-level name, for example `mpl_toolkits` or
 * `google`. They cannot both be a symbolic link at one point, thus the shared
 * prefix becomes a real directory and both sides link beneath it. That promotion is
 * the only reason that a farm holds a real directory.
 *
 * The granularity is the top-level entry and never the file. That is what keeps an
 * `$ORIGIN`-relative RPATH working: the vendored `numpy.libs` of a wheel and its
 * `numpy` package come from one store directory, thus `$ORIGIN/../numpy.libs`
 * resolves inside that directory exactly as the wheel intended.
 *
 * A merge of two directories is the rule, and the one refusal is a collision of two
 * versions of ONE distribution — refer to {@link isVersionCollision}. A farm that
 * shadows one version with another in silence is worse than a farm that refuses.
 */
function planLinkTree(plan: LinkPlan, dst: string, hostSrc: string, bakedSrc: string): void {
    for (const entry of readdirSync(hostSrc).sort()) {
        if (plan.collision) return;
        if (NOT_CONTENT.has(entry)) continue;

        const target = `${bakedSrc}/${entry}`;
        const hostTarget = join(hostSrc, entry);
        const link = join(dst, entry);
        const at = entryAt(plan, link);

        switch (at.kind) {
            case "absent": {
                plan.ops.push({ kind: "symlink", path: link, target });
                plan.planned.set(link, { kind: "link", target });
                break;
            }
            case "link": {
                // The identical link is already there. An extension re-links no
                // closure member, thus this is the idempotent case and never a
                // collision. The provisioner cannot reach it, because it builds the
                // Python track again from an empty tree.
                if (at.target === target) break;
                const hostPrevious = hostPathOf(plan.storeRoot, at.target);
                if (isVersionCollision(at.target, target)) refuse(plan, entry, at.target, target);
                else if (isHostDir(hostPrevious) && isHostDir(hostTarget)) {
                    plan.ops.push({ kind: "unlink", path: link }, { kind: "mkdir", path: link });
                    plan.planned.set(link, { kind: "dir" });
                    planLinkTree(plan, link, hostPrevious, at.target);
                    planLinkTree(plan, link, hostTarget, target);
                } else {
                    keepFirst(plan, entry, at.target, target);
                }
                break;
            }
            case "dir": {
                // A promotion of an earlier composition made this directory. A merge
                // into it adds links and touches none, thus it stays additive.
                //
                // A promoted directory carries no one store directory, thus a version
                // collision against it cannot be read here. The closure walk is what
                // prevents one: a graph closure names one version of a distribution.
                // The refusal of the `link` case above is the net for the pair, and the
                // provisioner has the same limit at the same point.
                if (isHostDir(hostTarget)) planLinkTree(plan, link, hostTarget, target);
                else keepFirst(plan, entry, link, target);
                break;
            }
            case "other": {
                keepFirst(plan, entry, link, target);
                break;
            }
            default: {
                // The union is closed, thus the compiler proves that this is unreachable.
                const unreachable: never = at;
                throw new Error(`unhandled farm entry: ${JSON.stringify(unreachable)}`);
            }
        }
    }
}

/** Replay a plan. Every question that the plan asked is settled, thus this step only writes. */
function applyLinkPlan(ops: readonly LinkOp[]): void {
    for (const op of ops) {
        switch (op.kind) {
            case "mkdir":
                mkdirSync(op.path, { recursive: true });
                break;
            case "unlink":
                unlinkSync(op.path);
                break;
            case "symlink":
                symlinkSync(op.target, op.path);
                break;
            default: {
                const unreachable: never = op;
                throw new Error(`unhandled link op: ${JSON.stringify(unreachable)}`);
            }
        }
    }
}

// --- The template -------------------------------------------------------------

/** What the catalog template gives a new farm: the home of its warm caches, its R subtree map, and its architecture. */
type Template = {
    /** The farm of the template on the host. A warm-cache link of an analysis farm points into it. */
    readonly path: string;
    /** Which R subtree each R store directory of the template belongs to. */
    readonly rSubtrees: ReadonlyMap<string, RSubtree>;
    /** The `arch` field of the template metadata, which every farm of the store shares. */
    readonly arch: string | null;
};

const farmLockSchema = z.object({
    requested: z.array(z.string()).default([]),
    resolved: z.array(z.string()).default([]),
    store_dirs: z.array(z.string()).default([]),
});

const farmMetaSchema = z.object({ arch: z.string().optional() });

/**
 * The canonical name and the version that a store-directory name records, or `null`
 * when the name has a different shape.
 *
 * The provisioner mints the name as `<canonical name>-<version>-<digest>`
 * (`ensure_stored`), thus the leading part is the distribution name in the form of
 * PEP 503 and the middle part is the resolved version. The name is the ONE record of
 * a version on the host, because the graph keys a node by its store directory.
 */
function partsOfStoreDir(storeDir: string): { readonly name: string; readonly version: string } | null {
    const [, name, version] = STORE_DIR_NAME.exec(storeDir) ?? [];
    if (name === undefined || version === undefined) return null;
    return { name, version };
}

/**
 * The canonical name that a store-directory name records, or `null` when the name
 * has a different shape.
 *
 * The pool inventory reads it, because the graph is keyed by store directory and a
 * reader wants the name of the distribution.
 */
export function nameOfStoreDir(storeDir: string): string | null {
    return partsOfStoreDir(storeDir)?.name ?? null;
}

/**
 * The canonical form of a distribution name, in the rule of PEP 503: each run of
 * `-`, `_`, and `.` becomes one `-`, and the result is lower case.
 *
 * A store directory carries the canonical name already, and the emitter keys
 * {@link DepsGraph.byName} by that same form. Thus the rule applies to the name that
 * a CALLER gives, so `Typing_Ext` and `typing-ext` reach one pool. An R name reaches
 * the same rule, because a store directory of the R track carries a lowercase name
 * too.
 *
 * This is the one host copy of the rule. The flight key, the pool inventory, and the
 * request resolution each name one distribution, thus each one must agree. The
 * provisioner holds the matching copy (`emit_deps.py`, `canon`), because the graph
 * that it writes carries these names.
 */
export function canonicalDistributionName(name: string): string {
    return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** Which R subtree each R store directory of a farm belongs to, read from the links of that farm. */
function readRSubtrees(farmPath: string): Map<string, RSubtree> {
    const found = new Map<string, RSubtree>();
    for (const subtree of R_SUBTREES) {
        const dir = join(farmPath, "r", subtree);
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            continue; // A subtree that a farm does not carry is a normal state.
        }
        for (const entry of entries) {
            try {
                const storeDir = storeDirOf(readlinkSync(join(dir, entry)));
                if (storeDir !== null) found.set(storeDir, subtree);
            } catch {
                continue; // An entry that is not a link belongs to no store directory.
            }
        }
    }
    return found;
}

/**
 * Read the catalog template.
 *
 * The template is the one home of a prepared cache, and it is NEVER the content of an
 * analysis farm. A composition invents no package set: it links what its caller
 * names, and it links nothing else. Thus the template gives three facts only — the
 * path that a warm-cache link points at, the R subtree of each R store directory, and
 * the architecture that every farm of the store shares.
 *
 * The R subtree comes from the links of the template, because the lock of the
 * provisioner records counts for R and never names.
 *
 * A template whose lock names no store directory is not a template that a download
 * wrote, thus the read refuses. A farm that guessed the two facts above would bake a
 * link target or an architecture that the store does not serve.
 */
function readTemplate(storeRoot: string): Result<Template, FarmCompositionError> {
    const path = join(storeRoot, FARMS_DIR, CATALOG_FARM);
    if (!isHostDir(path)) {
        return err({ type: "template_unusable", path, detail: "the catalog template farm is absent — run `inflexa store download`" });
    }

    const rSubtrees = readRSubtrees(path);
    const arch = readFileResult(join(path, FARM_METADATA), "read the template metadata").match(
        (raw) => JSON.parseWith(raw, farmMetaSchema)?.arch ?? null,
        () => null,
    );

    return readFileResult(join(path, FARM_LOCK), "read the template lock")
        .mapErr((cause): FarmCompositionError => ({ type: "template_unusable", path, detail: `the lock of the template is unreadable (${cause.op})` }))
        .andThen((raw) => {
            const lock = JSON.parseWith(raw, farmLockSchema);
            if (lock === null) return err<Template, FarmCompositionError>({ type: "template_unusable", path, detail: "the lock of the template is malformed" });

            const storeDirs = new Set([...lock.store_dirs, ...rSubtrees.keys()]);
            if (storeDirs.size === 0) {
                return err<Template, FarmCompositionError>({ type: "template_unusable", path, detail: "the lock of the template names no store directory" });
            }
            return ok<Template, FarmCompositionError>({ path, rSubtrees, arch });
        });
}

// --- The markers --------------------------------------------------------------

/** The names that `packages.txt` advertises for each track of a composed farm. */
type Inventory = { readonly cran: string[]; readonly bioconductor: string[]; readonly github: string[]; readonly python: string[] };

/** The names of a farm, read from the farm itself, exactly as the shared producer re-derives them. */
function readInventory(farmPath: string): Inventory {
    const inventory: Inventory = { cran: [], bioconductor: [], github: [], python: [] };
    for (const subtree of R_SUBTREES) {
        try {
            inventory[subtree].push(...readdirSync(join(farmPath, "r", subtree)).filter((entry) => !entry.startsWith(".")));
        } catch {
            continue; // A subtree that the farm does not carry advertises no section.
        }
    }
    try {
        for (const entry of readdirSync(join(farmPath, "python", "site-packages"))) {
            const name = DIST_INFO_NAME.exec(entry)?.[1];
            if (name !== undefined) inventory.python.push(name.replace(/_/g, "-"));
        }
    } catch {
        // A farm with no Python track advertises no Python section.
    }
    return inventory;
}

/** The tracks that a farm carries, read from the farm as it publishes and not from the work of the run. */
function farmTracks(farmPath: string): string[] {
    const tracks: string[] = [];
    try {
        if (readdirSync(join(farmPath, "python", "site-packages")).length > 0) tracks.push("python");
    } catch {
        // No Python track.
    }
    if (R_SUBTREES.some((subtree) => isHostDir(join(farmPath, "r", subtree)))) tracks.push("r");
    return tracks;
}

/**
 * Write the three farm markers.
 *
 * `packages.txt` and `meta.json` are the two completeness markers that the
 * usability gate of the harness requires. They go LAST, after every link, thus a
 * composition that stops halfway leaves a farm that the gate refuses instead of a
 * farm that mounts short.
 *
 * `packages.txt` comes from one fragment for each track, in the header and the
 * order of the shared producer (`images/sandbox-base/inflexa-libs-refresh`),
 * because the harness parses the result and every store must present one shape.
 */
function writeFarmMarkers(
    farmPath: string,
    farmName: string,
    arch: string | null,
    roots: readonly string[],
    storeDirs: readonly string[],
): Result<string[], FsError> {
    const inventory = readInventory(farmPath);
    const files: { readonly path: string; readonly content: string; readonly op: string }[] = [];
    let body = INVENTORY_HEADER;

    for (const track of INVENTORY_ORDER) {
        const names = inventory[track];
        if (names.length === 0) continue;
        const { fragment, title } = INVENTORY_TRACKS[track];
        const content = `## ${title}\n${[...new Set(names)].sort().join(", ")}\n`;
        files.push({ path: join(farmPath, fragment), content, op: "write the inventory fragment of the farm" });
        body += `${content}\n`;
    }
    files.push({ path: join(farmPath, FARM_INVENTORY), content: body, op: "write the inventory of the farm" });

    const tracks = farmTracks(farmPath);
    const meta = { version: farmName, arch: arch ?? hostArch(), tracks };
    files.push({ path: join(farmPath, FARM_METADATA), content: `${JSON.stringify(meta, null, 2)}\n`, op: "write the metadata of the farm" });

    // The lock is the record of the composition. `requested` holds the roots of the
    // walk, and a root of a composed farm is a store directory, because the composer
    // resolves before it links. The provisioner records a pip specifier in the same
    // field, because it resolves as it writes. Only the composer reads the lock of an
    // analysis farm, thus the two meanings never meet.
    const lock = {
        requested: [...roots].sort(),
        resolved: [],
        store_dirs: [...storeDirs].sort(),
        r: { packages: Object.fromEntries(R_SUBTREES.map((subtree) => [subtree, inventory[subtree].length])) },
        tracks: { built: tracks, preserved: [] },
        collisions: [],
    };
    files.push({ path: join(farmPath, FARM_LOCK), content: `${JSON.stringify(lock, null, 2)}\n`, op: "write the lock of the farm" });

    // The fold stops at the first failure, thus the two completeness markers are
    // never written over a farm whose earlier fragment could not land.
    return files
        .reduce<Result<void, FsError>>((soFar, file) => soFar.andThen(() => writeFileResult(file.path, file.content, file.op)), ok(undefined))
        .map(() => tracks);
}

/**
 * The architecture that the store serves, in the vocabulary of the provisioner.
 *
 * The template metadata is the first source, because the store was published for
 * one architecture. This is the fallback for a store whose template records none.
 */
function hostArch(): string {
    return process.arch === "arm64" ? "linux-arm64" : "linux-amd64";
}

// --- The composition ----------------------------------------------------------

/** Bridge a synchronous filesystem call into a Result. The composer writes with `node:fs`, which throws. */
function tryFs<T>(op: string, body: () => T): Result<T, FarmCompositionError> {
    try {
        return ok(body());
    } catch (cause) {
        return err({ type: "io_failed", op, cause });
    }
}

/**
 * Link a closure into a farm, and write the markers.
 *
 * The pass is additive by construction: it plans against the farm as it is, and it
 * writes an operation only where the farm holds nothing yet. Thus a live sandbox of
 * the farm keeps every resolution that it made, and the next import inside that same
 * sandbox resolves the new links.
 */
function linkClosure(
    storeRoot: string,
    farmPath: string,
    analysisId: string,
    graph: DepsGraph,
    closure: ReadonlySet<string>,
    template: Template,
    roots: readonly string[],
): Result<FarmComposition, FarmCompositionError> {
    const site = join(farmPath, "python", "site-packages");
    const ordered = [...closure].sort();
    const python = ordered.filter((key) => graph.nodes.get(key)?.track === "python");
    const rNodes = ordered.filter((key) => graph.nodes.get(key)?.track === "r");

    const plan: LinkPlan = { storeRoot, ops: [], planned: new Map(), collision: null, keptFirst: [] };
    const planned = tryFs("plan the links of the farm", () => {
        plan.ops.push({ kind: "mkdir", path: site });
        for (const key of python) {
            if (plan.collision) break;
            planLinkTree(plan, site, join(storeRoot, POOL_DIR, key), bakedPoolPath(key));
        }

        // The R links name the INNER directory of the store directory, whose base name
        // is the real package name. Thus a package that rebuilds its own path as
        // `libname/packagename` resolves itself through the link.
        for (const key of rNodes) {
            const rDir = graph.nodes.get(key)?.rDir;
            if (rDir === undefined || rDir === null) continue;
            const subtree = template.rSubtrees.get(key) ?? "cran";
            const link = join(farmPath, "r", subtree, rDir);
            if (entryAt(plan, link).kind !== "absent") continue;
            plan.ops.push({ kind: "mkdir", path: join(farmPath, "r", subtree) }, { kind: "symlink", path: link, target: `${bakedPoolPath(key)}/${rDir}` });
            plan.planned.set(link, { kind: "link", target: `${bakedPoolPath(key)}/${rDir}` });
        }

        // The warm caches are LINKS into the template and never copies. A cache entry
        // that does not match the package version of this farm misses and recompiles.
        for (const cache of WARM_CACHE_DIRS) {
            const link = join(farmPath, cache);
            if (!isHostDir(join(template.path, cache))) continue;
            if (entryAt(plan, link).kind !== "absent") continue;
            const target = `${SANDBOX_LIB_MOUNT}/${FARMS_DIR}/${CATALOG_FARM}/${cache}`;
            plan.ops.push({ kind: "symlink", path: link, target });
            plan.planned.set(link, { kind: "link", target });
        }
        return plan;
    });
    if (planned.isErr()) return err(planned.error);
    if (plan.collision) return err({ type: "version_collision", ...plan.collision });

    const applied = tryFs("write the links of the farm", () => {
        applyLinkPlan(plan.ops);
        hoistEntryPoints(storeRoot, farmPath);
    });
    if (applied.isErr()) return err(applied.error);

    return writeFarmMarkers(farmPath, analysisId, template.arch, roots, ordered)
        .mapErr((cause): FarmCompositionError => cause)
        .map((tracks) => ({
            farmPath,
            roots: [...roots].sort(),
            storeDirs: ordered,
            added: plan.ops.filter((op) => op.kind === "symlink" && op.path.startsWith(site)).map((op) => op.path),
            tracks,
        }));
}

/**
 * Hoist the console scripts of the farm to one directory on PATH.
 *
 * `uv pip install --target` puts a console script under `<target>/bin`, thus the
 * scripts arrive scattered across the store directories and the farm merges them at
 * `python/site-packages/bin`. The hoisted link is RELATIVE to the farm itself,
 * because a farm can move and an absolute link would then dangle.
 *
 * The hoist runs after the apply and never inside the plan, because it reads the
 * `bin` directory that the apply just made. It writes only under `python/bin`,
 * which no other pass touches.
 */
function hoistEntryPoints(storeRoot: string, farmPath: string): void {
    const site = join(farmPath, "python", "site-packages");
    const bin = join(site, "bin");
    const stat = lstatSync(bin, { throwIfNoEntry: false });
    if (!stat) return;

    // The merged `bin` is a real directory, and a `bin` from one store directory is a
    // link whose target resolves at the sandbox mount and not on the host.
    const names = stat.isSymbolicLink() ? readdirSync(hostPathOf(storeRoot, readlinkSync(bin))) : stat.isDirectory() ? readdirSync(bin) : [];
    if (names.length === 0) return;

    const binroot = join(farmPath, "python", "bin");
    mkdirSync(binroot, { recursive: true });
    for (const entry of names.sort()) {
        if (NOT_CONTENT.has(entry)) continue;
        const link = join(binroot, entry);
        const target = `../site-packages/bin/${entry}`;
        const at = lstatSync(link, { throwIfNoEntry: false });
        // A hoist that is already correct stays as it is. An extension must touch no
        // existing link, and a live sandbox holds an open path through this directory.
        if (at?.isSymbolicLink() && readlinkSync(link) === target) continue;
        if (at) unlinkSync(link);
        symlinkSync(target, link);
    }
}

/**
 * Hold a composition while a live process holds the reclamation lock, and report
 * that process when the wait passes `deadline`.
 *
 * An acquisition flight waits for the same lock in the same shape, because it meets
 * the same hazard: a reclamation frees pool content that the caller is about to
 * reference. The holder of the lock is the signal, and the lock file alone is not —
 * {@link instanceLockHolder} answers `null` for a record that a dead process left.
 */
async function waitForNoReclamation(pollMs: number, deadline: number): Promise<number | null> {
    for (;;) {
        const holder = instanceLockHolder(LIB_STORE_RECLAIM_LOCK_KEY);
        if (holder === null) return null;
        if (Date.now() >= deadline) return holder;
        await Promise.sleep(pollMs);
    }
}

/**
 * Run one composition of a farm under the per-farm mutex, and yield to a live
 * reclamation when the caller links pool content.
 *
 * Two compositions of ONE farm serialize, because namespace promotion re-writes a
 * link as a directory and a reader between the unlink and the mkdir would see
 * nothing there. Two compositions of two different farms hold two different keys,
 * thus they run at the same time.
 *
 * The chain serializes the callers inside this process, and the lock file
 * serializes them across two processes. Both are necessary:
 * {@link acquireInstanceLock} is re-entrant for the pid that holds the key, thus the
 * lock file alone would let two callers of one process into the critical section.
 *
 * `reclaim` is the yield of a caller that LINKS a store directory, and it is `null`
 * for a caller that links none. A caller that yields does three steps, and the ORDER
 * of the last two is what makes the two parties exclusive:
 *
 * 1. It waits while a live process holds the reclamation lock. It holds NO farm key
 *    for that wait, thus a reclamation never waits for a composition that waits for
 *    the reclamation, and there is no deadlock.
 * 2. It takes the farm key, which is its liveness record.
 * 3. It reads the reclamation lock AGAIN, under that key, and it releases the key and
 *    waits again when a reclamation holds it.
 *
 * Step 3 is what closes the race. Each party writes its own record before it reads
 * the record of the other: a composition writes the farm key and then reads the
 * reclamation lock, and a reclamation takes its lock and then reads the farm keys.
 * Thus at least one of the two sees the other, and they never interleave.
 *
 * Each wait is bounded and each one ends in a named refusal, because a wait with no
 * end is worse than a refusal that the caller can report.
 */
async function underFarmMutex<T>(
    analysisId: string,
    reclaim: ReclaimYield | null,
    critical: () => Result<T, FarmCompositionError>,
): Promise<Result<T, FarmCompositionError>> {
    const key = `${FARM_LOCK_KEY_PREFIX}${analysisId}`;
    const deadline = Date.now() + (reclaim?.waitMs ?? 0);
    const ahead = farmQueue.get(key) ?? Promise.resolve();
    const run = ahead.then(async (): Promise<Result<T, FarmCompositionError>> => {
        let mutexWaited = 0;
        for (;;) {
            if (reclaim !== null) {
                const blocker = await waitForNoReclamation(reclaim.pollMs, deadline);
                if (blocker !== null) return err({ type: "reclaim_in_flight", analysisId, holderPid: blocker });
            }

            const lock = acquireInstanceLock(key);
            if (!lock.acquired) {
                if (mutexWaited >= FARM_MUTEX_WAIT_MS) return err({ type: "farm_locked", analysisId, holderPid: lock.holderPid });
                mutexWaited += FARM_MUTEX_POLL_MS;
                await Promise.sleep(FARM_MUTEX_POLL_MS);
                continue;
            }

            // The second read: a reclamation that started while this call took the key
            // cannot have seen the key, thus this call is the one that yields.
            if (reclaim !== null && instanceLockHolder(LIB_STORE_RECLAIM_LOCK_KEY) !== null) {
                releaseInstanceLock(key);
                continue;
            }

            try {
                return critical();
            } finally {
                releaseInstanceLock(key);
            }
        }
    });

    // The tail of the queue must never reject, or a later caller inherits the
    // rejection. The critical section gives a Result, thus a rejection here is a
    // programmer bug that its own caller still sees through `run`.
    const tail = run.then(
        () => undefined,
        () => undefined,
    );
    farmQueue.set(key, tail);
    try {
        return await run;
    } finally {
        if (farmQueue.get(key) === tail) farmQueue.delete(key);
    }
}

/**
 * Make the farm of an analysis, empty and with its markers. It links no package.
 *
 * The farm is made with the analysis, because the planner names the packages of a
 * plan INTO a farm and it cannot name them into a farm that does not exist. A farm is
 * a tree of links and a few small records, thus an empty one costs almost nothing and
 * an analysis that only chats keeps it that way.
 *
 * The farm carries the same three markers that a composed farm carries, and the two
 * completeness markers advertise an empty inventory. Thus the usability gate of the
 * harness accepts the farm, and the sandbox of a chat-only analysis mounts it.
 *
 * The read of the template is what gives the architecture of the store. A farm that
 * guessed it would record an architecture that the store does not serve.
 *
 * It takes the per-farm mutex, and it does NOT yield to a live reclamation. The
 * yield exists for one hazard only: a walk of the graph names a store directory that
 * no farm links yet, and a reclamation between the walk and the link would free it.
 * An empty farm walks no graph and it links no store directory, thus it can hold no
 * link that resolves to nothing. It still records its liveness through the mutex, so
 * a reclamation waits for the markers of the farm instead of reaping a farm that is
 * half written.
 */
export async function makeEmptyFarm(params: {
    readonly storeRoot: string;
    readonly analysisId: string;
}): Promise<Result<FarmComposition, FarmCompositionError>> {
    const farmPath = analysisFarmPath(params.storeRoot, params.analysisId);
    const made = await underFarmMutex(params.analysisId, null, () =>
        readTemplate(params.storeRoot).andThen((template) =>
            tryFs("make the farm directory", () => mkdirSync(farmPath, { recursive: true })).andThen(() =>
                writeFarmMarkers(farmPath, params.analysisId, template.arch, [], [])
                    .mapErr((cause): FarmCompositionError => cause)
                    .map((tracks) => ({ farmPath, roots: [], storeDirs: [], added: [], tracks })),
            ),
        ),
    );
    // The farm provider calls this inside the harness, thus the user never meets the
    // error type. The record is the channel back to the sandbox gate, which refuses
    // BEFORE an action starts and never sees a harness error.
    pendingFailure = made.match(
        () => null,
        (error) => ({ analysisId: params.analysisId, reason: describeFarmCompositionError(error) }),
    );
    return made;
}

/**
 * Extend the farm of an analysis with the closure of more roots.
 *
 * This is the ONE writer of the package links of a farm. It links the closure of
 * the roots that its caller names, and it links nothing else. It invents no
 * package set: the two routes that fill a farm are the plan of the analysis and a
 * step that names what its import could not find.
 *
 * The extension adds links and touches no existing link, thus a live sandbox of the
 * farm keeps every resolution that it made, and the next import inside that same
 * sandbox resolves the new links. No restart is necessary.
 *
 * A version collision refuses with both store directories, and the farm stays
 * exactly as it was, because the pass plans the whole extension before it writes
 * anything.
 *
 * The extension yields to a live reclamation, because the walk of the graph can
 * name a store directory that no farm links yet — refer to {@link underFarmMutex}.
 */
export function extendFarm(params: ExtendFarmParams, deps: FarmCompositionDeps = {}): Promise<Result<FarmComposition, FarmCompositionError>> {
    const farmPath = analysisFarmPath(params.storeRoot, params.analysisId);
    return underFarmMutex(params.analysisId, reclaimYield(deps), () =>
        readTemplate(params.storeRoot).andThen((template) =>
            readDepsGraph(params.storeRoot).andThen((graph) => {
                const previous = readFarmRoots(farmPath);
                const roots = [...new Set([...previous, ...params.roots])];
                return closureOf(graph, roots).andThen((closure) =>
                    tryFs("make the farm directory", () => mkdirSync(farmPath, { recursive: true })).andThen(() =>
                        linkClosure(params.storeRoot, farmPath, params.analysisId, graph, closure, template, roots),
                    ),
                );
            }),
        ),
    );
}

/**
 * Remove the farm of an analysis, after the lease check.
 *
 * A lease is one file under `leases/` at the store root, and the provisioner writes
 * one for each live sandbox. A lease that names this farm holds it. A lease that
 * names NO farm can belong to a sandbox of any farm, thus it holds every farm. The
 * removal refuses while either kind is present, because a live sandbox resolves
 * these links right now.
 *
 * An absent farm is a normal state, not an error: a chat-only analysis composes no
 * farm, and its deletion has nothing to remove. The pool is untouched either way,
 * and reclamation frees what no farm references.
 *
 * The removal takes the per-farm mutex, and it does NOT yield to a live reclamation.
 * It links nothing, thus it can hold no link that resolves to nothing. It is also
 * the orphan-farm reaper of the reclamation itself, and a yield there would make the
 * reclamation wait for its own lock.
 */
export function removeAnalysisFarm(params: RemoveFarmParams): Promise<Result<FarmRemoval, FarmCompositionError>> {
    const farmPath = analysisFarmPath(params.storeRoot, params.analysisId);
    return underFarmMutex(params.analysisId, null, () => {
        if (!isHostDir(farmPath)) return ok<FarmRemoval, FarmCompositionError>({ farmPath, removed: false });
        const holders = leasesOfFarm(params.storeRoot, params.analysisId);
        if (holders.length > 0) return err<FarmRemoval, FarmCompositionError>({ type: "farm_leased", analysisId: params.analysisId, leases: holders });
        return tryFs("remove the farm", () => rmSync(farmPath, { recursive: true, force: true })).map(() => ({ farmPath, removed: true }));
    });
}

/**
 * The farm of one analysis on the host, at `<storeRoot>/farms/<analysisId>`.
 *
 * The farm provider that the CLI hands the harness reads the same path, thus the
 * naming rule of the store lives here and never at the composition root.
 */
export function analysisFarmPath(storeRoot: string, analysisId: string): string {
    return join(storeRoot, FARMS_DIR, analysisId);
}

const leaseSchema = z.object({ lease: z.string().optional(), farm: z.string().nullable().optional() });

/** The ids of the leases that hold one farm, which are the leases that name it and the leases that name none. */
function leasesOfFarm(storeRoot: string, farmName: string): string[] {
    const dir = join(storeRoot, LEASES_DIR);
    let entries: string[];
    try {
        entries = readdirSync(dir).sort();
    } catch {
        return []; // No lease directory means no live sandbox.
    }
    return entries.filter((entry) => {
        const record = readFileResult(join(dir, entry), "read a sandbox lease").match(
            (raw) => JSON.parseWith(raw, leaseSchema),
            () => null,
        );
        // An unreadable or malformed lease names no farm, thus it holds every farm.
        const farm = record?.farm ?? null;
        return farm === null || farm === farmName;
    });
}

/**
 * The roots that a farm already holds, read from its own lock.
 *
 * Only the composer writes the lock of an analysis farm, thus `requested` there is
 * a list of store directories. A farm with no readable lock has no recorded roots,
 * and the extension then rests on the roots that its caller names.
 */
function readFarmRoots(farmPath: string): string[] {
    return readFileResult(join(farmPath, FARM_LOCK), "read the lock of the farm").match(
        (raw) => JSON.parseWith(raw, farmLockSchema)?.requested ?? [],
        () => [],
    );
}
