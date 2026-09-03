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
 * else (`env.packageStoreDir`), thus the composer cannot stat a baked path. It
 * carries the two paths side by side: the host path for each filesystem question,
 * and the baked path for the text that it writes into the link.
 *
 * **The plan and the apply.** The link pass runs in two steps. The first step
 * plans the operations against an overlay of the farm, and it writes nothing. The
 * second step replays the plan. Thus a version collision refuses with the farm
 * exactly as it was, and an extension can prove that it touches no existing link.
 *
 * **The one metadata file.** A farm carries `inflexa.lock` at schema 1 beside its
 * link trees and its cache, and nothing else. The harness mount gate and the
 * package inventory read that one file, thus the composer writes the same shape
 * that the provisioner writes ({@link FarmLockSchema} is the shared contract).
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { FARM_LOCK_FILE, readFarmLock } from "@inflexa-ai/harness";
import type { FarmLock, FarmResolution, PackageRequest, PackageRequestOutcome } from "@inflexa-ai/harness";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { acquireInstanceLock, instanceLockHolder, releaseInstanceLock, PACKAGE_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { type FsError, readFileResult, writeFileResult } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";

// --- The store layout ---------------------------------------------------------

/** The content-addressed pool, under the store root. */
const POOL_DIR = "store";

/** The farms, under the store root. One farm for each analysis, plus the catalog. */
const FARMS_DIR = "farms";

/** The resolved dependency graph, at the store root. `emit_deps.py` publishes it. */
const GRAPH_NAME = "deps.json";

/** The schema version of the graph that this reader understands. */
const GRAPH_VERSION = 1;

/**
 * The farm that the published catalog brings. It is the TEMPLATE, never an
 * environment: an extension reads its lock for the R subtrees and the language
 * facts, and a new farm copies its prepared caches.
 */
export const CATALOG_FARM = "catalog";

/**
 * The path the sandbox mounts the store root at, read-only. A farm link bakes an
 * absolute target beneath it, exactly as `provision.py` does, because the link
 * text must resolve inside the sandbox and not on the host.
 */
const SANDBOX_LIB_MOUNT = "/mnt/libs";

/**
 * The entries of a store directory that are records of the store, not content.
 * The provisioner skips the same names when it links a store directory.
 */
const NOT_CONTENT: ReadonlySet<string> = new Set([".inflexa-pin", ".inflexa-hash", ".inflexa-r-linking", ".lock"]);

/**
 * The marker inside a store directory that carries the full sha256 of the sorted
 * tree, written at store time. The farm lock carries the full hash of each
 * package, and the marker saves a re-hash of the pool at each composition. An R
 * store directory nests the package one level down, thus its marker sits inside
 * the inner directory.
 */
const HASH_MARKER = ".inflexa-hash";

/** The three R library subtrees that `R_LIBS_SITE` carries, in the order the provisioner uses. */
const R_SUBTREES = ["cran", "bioconductor", "github"] as const;

/** One of the three R library subtrees. */
type RSubtree = (typeof R_SUBTREES)[number];

/** The two runtime tracks of the store. */
const TRACKS = ["python", "r"] as const;

/** One of the two runtime tracks. */
type Track = (typeof TRACKS)[number];

/**
 * The prepared cache directories of the catalog farm. A new farm SEEDS its own
 * read-write cache from them, as a copy and never a link: a loaded numba entry
 * executes machine code, thus a shared writable cache would let one analysis
 * plant code for another. A copy that goes stale misses and recompiles, which is
 * safe.
 */
const WARM_CACHE_DIRS = ["numba-cache", "matplotlib_config"] as const;

/** The per-analysis read-write cache, under the farm. The sandbox mounts it at `/mnt/libs/cache`. */
const FARM_CACHE_DIR = "cache";

// --- The two locks of a composition -------------------------------------------
//
// A composition meets two different locks, and each one protects a different thing.
//
// The PER-FARM MUTEX (`farm-<analysisId>`) protects one farm against a second
// writer of that same farm. It is also the liveness record of the composition,
// because a reclamation reads the live holders of this key family and waits for
// them.
//
// The RECLAMATION LOCK ({@link PACKAGE_STORE_RECLAIM_LOCK_KEY}) protects the
// POOL. A reclamation holds it for its whole run, and it frees a store directory
// that a walk of the graph can already name.
//
// The ORDER is fixed, and the fixed order is what prevents a deadlock. A
// reclamation takes the reclamation lock FIRST, and it takes a farm key later,
// inside its orphan-farm reaper. A composition waits for the reclamation lock
// while it holds NO farm key, and a reclamation that starts under the key makes
// it release that key and wait again. Thus no party holds one lock and waits for
// the other, and there is no cycle.

/**
 * The prefix of the instance-lock key of one farm. The analysis id follows it, and
 * that id is a UUIDv7, thus the key collides with no sentinel key.
 *
 * A reclamation reads the live holders of this key family, because that is the
 * liveness record of a composition and the reclamation cannot name the analysis
 * ids itself. The analysis delete gate reads the same family for the same reason.
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
    name: z.string(),
    version: z.string(),
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
    readonly track: Track;
    /** The canonical distribution name, as the emitter minted it. */
    readonly name: string;
    /** The resolved version, as the emitter minted it. */
    readonly version: string;
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
     * The EMITTER settles the order through the `order` strings of the nodes, and
     * the host orders nothing itself. A request that names no version takes the
     * head of the list.
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
    /** The catalog farm is absent or its lock is unusable, thus there is no R subtree map and no language record. */
    | { readonly type: "template_unusable"; readonly path: string; readonly detail: string }
    /**
     * Two store directories claim one top-level name, and the composer cannot merge
     * them. The farm stays exactly as it was. Each `neededBy` list holds the
     * closure members whose edges pull that side, as `name==version` — empty
     * for a requested root. Without the dependents, a reader must guess which
     * package pulls each pin, and a wrong guess turns into store surgery.
     */
    | {
          readonly type: "version_collision";
          readonly name: string;
          readonly existing: string;
          readonly incoming: string;
          readonly existingNeededBy: readonly string[];
          readonly incomingNeededBy: readonly string[];
      }
    /** A different process composes this farm right now, and it did not finish inside the wait. */
    | { readonly type: "farm_locked"; readonly analysisId: string; readonly holderPid: number }
    /** A reclamation of the pool runs right now, and it did not finish inside the wait. */
    | { readonly type: "reclaim_in_flight"; readonly analysisId: string; readonly holderPid: number };

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
        case "version_collision": {
            // The dependents ARE the remedy surface: the fix is to drop or re-pin
            // a dependent, thus the one line must name it. The render caps the
            // list, and the error keeps it whole.
            const side = (dir: string, neededBy: readonly string[]): string => {
                if (neededBy.length === 0) return `${dir} (a requested package)`;
                const head = neededBy.slice(0, 3).join(", ");
                const rest = neededBy.length > 3 ? ` and ${neededBy.length - 3} more` : "";
                return `${dir} (needed by ${head}${rest})`;
            };
            return `two store directories claim the name "${error.name}": ${side(error.existing, error.existingNeededBy)} and ${side(error.incoming, error.incomingNeededBy)}`;
        }
        case "farm_locked":
            return `another process (pid ${error.holderPid}) composes this farm right now`;
        case "reclaim_in_flight":
            return `a package-store reclamation (pid ${error.holderPid}) runs right now, and it frees the pool content that this farm would link`;
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
    /** The store directories that count as requested: the roots of this call and of each earlier call. */
    readonly roots: readonly string[];
    /** The whole closure of the roots, which is what the farm links. */
    readonly storeDirs: readonly string[];
    /** The store directories that THIS call added to the closure. Empty when the farm already held it whole. */
    readonly added: readonly string[];
    /** The tracks that the farm carries. */
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
    /** The store root that the CLI owns, which is `env.packageStoreDir`. */
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
    /** The store root that the CLI owns, which is `env.packageStoreDir`. */
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
                name: node.name,
                version: node.version,
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
          /** The canonical form of the name that the request named. */
          readonly name: string;
      }
    | {
          /** The pool holds the name, and it holds no such version of it. */
          readonly type: "unknown_version";
          /** The canonical form of the name that the request named. */
          readonly name: string;
          /** The version that the request named. */
          readonly version: string;
          /** The versions that the pool does hold, newest first. */
          readonly available: readonly string[];
      }
    | {
          /**
           * The Python track and the R track both hold the name, and the request
           * names no ecosystem. A silent pick is a fault, thus the resolution
           * stops with the two candidates. An interactive caller asks the user,
           * and the seam route reports the pair as agent guidance.
           */
          readonly type: "ambiguous_ecosystem";
          /** The canonical form of the name that the request named. */
          readonly name: string;
          /** The head store directory of each track that holds the name: Python first, then R. */
          readonly candidates: readonly [string, string];
      };

/**
 * The store directory of the pool that answers one package request.
 *
 * `store link`, `store add`, and the farm-extension seam of the harness share this
 * one lookup, thus a package that a person names and a package that a failed
 * import names reach the pool by one rule. The answer is a root of a composition,
 * and the composition takes its closure.
 *
 * The lookup NEVER orders two versions. {@link DepsGraph.byName} arrives newest
 * first, because the emitter has the metadata of each ecosystem and the host does
 * not. Thus a request with no version takes the head of that list.
 *
 * A request with no ecosystem searches both tracks. When both tracks hold the
 * name, the lookup refuses with the two candidates — there is no silent
 * Python-first pick.
 */
export function resolvePackageRequest(graph: DepsGraph, request: PackageRequest): Result<ResolvedRequest, RequestResolutionError> {
    const name = canonicalDistributionName(request.name);
    const tracks: readonly Track[] = request.ecosystem === undefined ? TRACKS : [request.ecosystem];

    const held = tracks.filter((track) => (graph.byName[track].get(name) ?? []).length > 0);
    const [track, second] = held;
    if (track === undefined) return err({ type: "unknown_distribution", name });
    if (second !== undefined) {
        // `held` preserves the order of TRACKS, thus the pair is Python first.
        const python = graph.byName[track].get(name)?.[0] as string;
        const r = graph.byName[second].get(name)?.[0] as string;
        return err({ type: "ambiguous_ecosystem", name, candidates: [python, r] });
    }

    const candidates = (graph.byName[track].get(name) ?? []).flatMap((storeDir) => {
        const node = graph.nodes.get(storeDir);
        return node === undefined ? [] : [{ storeDir, name, version: node.version, track }];
    });
    const [head] = candidates;
    if (head === undefined) return err({ type: "unknown_distribution", name });
    if (request.version === undefined) return ok(head);

    const exact = candidates.find((candidate) => candidate.version === request.version);
    if (exact === undefined) {
        return err({ type: "unknown_version", name, version: request.version, available: candidates.map((candidate) => candidate.version) });
    }
    return ok(exact);
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
 * `__init__.py`. A merge is what the provisioner does with them, and what an
 * install into one `site-packages` produces. Thus a refusal there would refuse each
 * farm that links both distributions, which the published catalog makes common.
 */
function isVersionCollision(graph: DepsGraph, existingTarget: string, incomingTarget: string): boolean {
    const existingDir = storeDirOf(existingTarget);
    const incomingDir = storeDirOf(incomingTarget);
    if (existingDir === null || incomingDir === null || existingDir === incomingDir) return false;
    const existing = graph.nodes.get(existingDir)?.name;
    const incoming = graph.nodes.get(incomingDir)?.name;
    return existing !== undefined && existing === incoming;
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
    readonly graph: DepsGraph;
    readonly storeRoot: string;
    readonly ops: LinkOp[];
    /** The planned state of a path that the plan already changed. It shadows the disk. */
    readonly planned: Map<string, FarmEntry>;
    collision: { readonly name: string; readonly existing: string; readonly incoming: string } | null;
    /**
     * A name that two store directories give, where no merge can hold both — one side
     * is a file. The plan keeps the first side, exactly as the provisioner does, and
     * the farm lock records the name under `merge_conflicts`.
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
function keepFirst(plan: LinkPlan, name: string): void {
    plan.keptFirst.push(name);
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
                if (isVersionCollision(plan.graph, at.target, target)) refuse(plan, entry, at.target, target);
                else if (isHostDir(hostPrevious) && isHostDir(hostTarget)) {
                    plan.ops.push({ kind: "unlink", path: link }, { kind: "mkdir", path: link });
                    plan.planned.set(link, { kind: "dir" });
                    planLinkTree(plan, link, hostPrevious, at.target);
                    planLinkTree(plan, link, hostTarget, target);
                } else {
                    keepFirst(plan, entry);
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
                else keepFirst(plan, entry);
                break;
            }
            case "other": {
                keepFirst(plan, entry);
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

// --- The catalog template -----------------------------------------------------

/** What the catalog farm gives an extension: its path, its R subtree map, and the store-wide lock facts. */
type Template = {
    /** The farm of the catalog on the host, which is the home of the prepared caches. */
    readonly path: string;
    /** Which R subtree each R store directory of the catalog belongs to, from its lock. */
    readonly rSubtrees: ReadonlyMap<string, RSubtree>;
    /** The `arch` of the store, which every farm shares. */
    readonly arch: FarmLock["arch"];
    /** The per-language provenance of the store, which an analysis lock copies for the tracks it carries. */
    readonly languages: FarmLock["languages"];
};

/** Whether a lock `track` value names one of the three R subtrees. */
function isRSubtree(track: string): track is RSubtree {
    return (R_SUBTREES as readonly string[]).includes(track);
}

/**
 * Read the catalog farm as the template of an extension.
 *
 * The catalog is the one home of a prepared cache, and it is NEVER the content of
 * an analysis farm. A composition invents no package set: it links what its caller
 * names, and it links nothing else. Thus the template gives facts only — the R
 * subtree of each R store directory, the architecture, and the language record —
 * and its `inflexa.lock` carries every one of them.
 */
function readTemplate(storeRoot: string): Result<Template, FarmCompositionError> {
    const path = join(storeRoot, FARMS_DIR, CATALOG_FARM);
    if (!isHostDir(path)) {
        return err({ type: "template_unusable", path, detail: "the catalog farm is absent — run `inflexa store download`" });
    }
    return readFarmLock(path)
        .mapErr((cause): FarmCompositionError => ({ type: "template_unusable", path, detail: `the lock of the catalog farm is unusable (${cause.type})` }))
        .map((lock) => {
            const rSubtrees = new Map<string, RSubtree>();
            for (const entry of lock.packages) {
                if (isRSubtree(entry.track)) rSubtrees.set(entry.store_dir, entry.track);
            }
            return { path, rSubtrees, arch: lock.arch, languages: lock.languages };
        });
}

// --- The farm lock ------------------------------------------------------------

/**
 * The architecture of the host, in the vocabulary of the farm lock.
 *
 * An empty farm records it, because the catalog can still download when the farm
 * is made. The store always serves the host architecture — the download resolves
 * the `latest-<arch>` tag of the host — thus the two vocabularies cannot diverge.
 */
function hostArch(): FarmLock["arch"] {
    return process.arch === "arm64" ? "arm64" : "amd64";
}

/**
 * The full sha256 of one store directory, from its `.inflexa-hash` marker.
 *
 * The provisioner writes the marker at store time, thus the composer never hashes
 * the pool. A directory without one is not a directory that this store minted, and
 * the composition refuses rather than record a hash that it cannot know.
 */
function storedFullHash(storeRoot: string, storeDir: string, node: DepsNode): Result<string, FarmCompositionError> {
    const base = join(storeRoot, POOL_DIR, storeDir);
    const marker = node.rDir === null ? join(base, HASH_MARKER) : join(base, node.rDir, HASH_MARKER);
    return readFileResult(marker, `read the hash marker of ${storeDir}`).map((raw) => raw.trim());
}

/** One `packages` entry of the farm lock, for one linked store directory. */
function lockPackageEntry(
    storeRoot: string,
    storeDir: string,
    node: DepsNode,
    template: Template,
    requested: boolean,
): Result<FarmLock["packages"][number], FarmCompositionError> {
    return storedFullHash(storeRoot, storeDir, node).map((hash) => ({
        name: node.name,
        version: node.version,
        track: node.track === "python" ? "python" : (template.rSubtrees.get(storeDir) ?? "cran"),
        store_dir: storeDir,
        hash,
        // `requested` obeys the PEP 376 meaning: true for a direct ask, false for
        // a transitive dependency.
        requested,
    }));
}

/**
 * Write the `inflexa.lock` of a farm in one step: a temp file, then a rename.
 *
 * The lock goes LAST, after every link, thus a composition that stops halfway
 * leaves a farm that the mount gate refuses instead of a farm that mounts short.
 */
function writeFarmLockFile(farmPath: string, lock: FarmLock): Result<void, FsError> {
    const path = join(farmPath, FARM_LOCK_FILE);
    const temp = `${path}.tmp`;
    return writeFileResult(temp, `${JSON.stringify(lock, null, 2)}\n`, "write the lock of the farm").andThen(() => {
        try {
            renameSync(temp, path);
            return ok<void, FsError>(undefined);
        } catch (cause) {
            return err<void, FsError>({ type: "io_failed", op: "publish the lock of the farm", cause });
        }
    });
}

/**
 * The lock of a farm, or `null` when the farm has none that reads.
 *
 * A farm with no readable lock has no recorded closure and no recorded roots. The
 * extension then rests on the roots that its caller names, and the next lock write
 * heals the record.
 */
function readOwnLock(farmPath: string): FarmLock | null {
    return readFarmLock(farmPath).match(
        (lock) => lock,
        () => null,
    );
}

/** The store directories that a farm requested directly, read from its own lock. */
function readFarmRoots(farmPath: string): string[] {
    const lock = readOwnLock(farmPath);
    return lock === null ? [] : lock.packages.filter((entry) => entry.requested).map((entry) => entry.store_dir);
}

/** The whole closure that a farm links right now, read from its own lock. */
export function readFarmClosure(farmPath: string): ReadonlySet<string> {
    const lock = readOwnLock(farmPath);
    return new Set(lock === null ? [] : lock.packages.map((entry) => entry.store_dir));
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

/** The tracks that a closure carries, in the fixed python-then-r order. */
function tracksOf(graph: DepsGraph, closure: readonly string[]): string[] {
    const present = new Set(closure.map((key) => graph.nodes.get(key)?.track));
    return TRACKS.filter((track) => present.has(track));
}

/**
 * The closure members whose edges name `storeDir`, as sorted `name==version`
 * lines. The scan stays inside the CLOSURE, because a dependent outside it
 * did not put the directory into this link set — only an in-closure edge
 * explains why the collision exists for THIS farm.
 */
function closureDependents(graph: DepsGraph, closure: ReadonlySet<string>, storeDir: string): string[] {
    const dependents: string[] = [];
    for (const member of closure) {
        const node = graph.nodes.get(member);
        if (node !== undefined && node.edges.includes(storeDir)) dependents.push(`${node.name}==${node.version}`);
    }
    return dependents.sort();
}

/**
 * Link a closure into a farm, and write its lock.
 *
 * The pass is additive by construction: it plans against the farm as it is, and it
 * writes an operation only where the farm holds nothing yet. Thus a live sandbox of
 * the farm keeps every resolution that it made, and the next import inside that same
 * sandbox resolves the new links.
 */
function linkClosure(
    storeRoot: string,
    farmPath: string,
    graph: DepsGraph,
    closure: ReadonlySet<string>,
    template: Template,
    roots: readonly string[],
): Result<FarmComposition, FarmCompositionError> {
    const site = join(farmPath, "python", "site-packages");
    const ordered = [...closure].sort();
    const python = ordered.filter((key) => graph.nodes.get(key)?.track === "python");
    const rNodes = ordered.filter((key) => graph.nodes.get(key)?.track === "r");
    const before = readFarmClosure(farmPath);

    const plan: LinkPlan = { graph, storeRoot, ops: [], planned: new Map(), collision: null, keptFirst: [] };
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
        return plan;
    });
    if (planned.isErr()) return err(planned.error);
    if (plan.collision) {
        return err({
            type: "version_collision",
            ...plan.collision,
            existingNeededBy: closureDependents(graph, closure, plan.collision.existing),
            incomingNeededBy: closureDependents(graph, closure, plan.collision.incoming),
        });
    }

    const applied = tryFs("write the links of the farm", () => {
        applyLinkPlan(plan.ops);
        hoistEntryPoints(storeRoot, farmPath);
    });
    if (applied.isErr()) return err(applied.error);

    const requested = new Set(roots);
    const entries = ordered.reduce<Result<FarmLock["packages"][number][], FarmCompositionError>>(
        (soFar, key) =>
            soFar.andThen((list) => {
                const node = graph.nodes.get(key);
                // The closure walk proves that each key is a node of the graph.
                if (node === undefined) return ok(list);
                return lockPackageEntry(storeRoot, key, node, template, requested.has(key)).map((entry) => [...list, entry]);
            }),
        ok([]),
    );
    if (entries.isErr()) return err(entries.error);

    const tracks = tracksOf(graph, ordered);
    const lock: FarmLock = {
        schema: 1,
        arch: template.arch,
        packages: entries.value.sort((one, two) => (one.track + one.name).localeCompare(two.track + two.name)),
        languages: {
            ...(tracks.includes("python") && template.languages.python !== undefined ? { python: template.languages.python } : {}),
            ...(tracks.includes("r") && template.languages.r !== undefined ? { r: template.languages.r } : {}),
        },
        ...(plan.keptFirst.length > 0 ? { merge_conflicts: plan.keptFirst.sort().map((entry) => ({ entry, action: "kept-first" as const })) } : {}),
    };

    return writeFarmLockFile(farmPath, lock)
        .mapErr((cause): FarmCompositionError => cause)
        .map(() => ({
            farmPath,
            roots: [...roots].sort(),
            storeDirs: ordered,
            added: ordered.filter((key) => !before.has(key)),
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
 * Seed the read-write cache of a farm from the prepared caches of the catalog.
 *
 * The copy is per analysis, never a shared link: a loaded numba entry executes
 * machine code, and a shared writable home would let one analysis plant code for
 * another. A missing catalog cache degrades in silence, because a cold cache
 * costs time and not correctness. A cache directory that the farm already holds
 * stays untouched, because the analysis can have written entries into it.
 */
function seedFarmCache(storeRoot: string, farmPath: string): void {
    const cacheRoot = join(farmPath, FARM_CACHE_DIR);
    try {
        mkdirSync(cacheRoot, { recursive: true });
    } catch (cause) {
        getLogger("farm").warn({ err: cause, cacheRoot }, "could not make the farm cache directory; the sandbox runs cold");
        return;
    }
    for (const cache of WARM_CACHE_DIRS) {
        const source = join(storeRoot, FARMS_DIR, CATALOG_FARM, cache);
        const target = join(cacheRoot, cache);
        if (!isHostDir(source) || existsSync(target)) continue;
        try {
            cpSync(source, target, { recursive: true });
        } catch (cause) {
            getLogger("farm").warn({ err: cause, cache }, "could not seed a prepared cache; the sandbox recompiles it");
            rmSync(target, { recursive: true, force: true });
        }
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
        const holder = instanceLockHolder(PACKAGE_STORE_RECLAIM_LOCK_KEY);
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
            if (reclaim !== null && instanceLockHolder(PACKAGE_STORE_RECLAIM_LOCK_KEY) !== null) {
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
 * Make the farm of an analysis, empty and with its lock. It links no package.
 *
 * The farm is made with the analysis, because the planner names the packages of a
 * plan INTO a farm and it cannot name them into a farm that does not exist. A farm
 * is a tree of links and one small record, thus an empty one costs almost nothing
 * and an analysis that only chats keeps it that way.
 *
 * The empty farm does NOT read the catalog. A user can make an analysis while the
 * catalog still downloads, and a farm that waited for the catalog would leave that
 * analysis with no farm forever. The architecture comes from the host, which is
 * the architecture that the download resolves. The cache seeds from the catalog
 * when the catalog is there, and it degrades in silence otherwise.
 *
 * It takes the per-farm mutex, and it does NOT yield to a live reclamation. The
 * yield exists for one hazard only: a walk of the graph names a store directory that
 * no farm links yet, and a reclamation between the walk and the link would free it.
 * An empty farm walks no graph and it links no store directory, thus it can hold no
 * link that resolves to nothing. It still records its liveness through the mutex, so
 * a reclamation waits for the lock of the farm instead of reaping a farm that is
 * half written.
 */
export async function makeEmptyFarm(params: {
    readonly storeRoot: string;
    readonly analysisId: string;
}): Promise<Result<FarmComposition, FarmCompositionError>> {
    const farmPath = analysisFarmPath(params.storeRoot, params.analysisId);
    const made = await underFarmMutex(params.analysisId, null, () =>
        tryFs("make the farm directory", () => mkdirSync(farmPath, { recursive: true }))
            .andThen(() =>
                writeFarmLockFile(farmPath, { schema: 1, arch: hostArch(), packages: [], languages: {} }).mapErr((cause): FarmCompositionError => cause),
            )
            .map(() => {
                seedFarmCache(params.storeRoot, farmPath);
                return { farmPath, roots: [], storeDirs: [], added: [], tracks: [] };
            }),
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
 * Compose the FULL farm of a farm-less analysis from the catalog closure.
 *
 * The missing farm is the pre-release discriminator: creation makes the farm
 * with the analysis, thus an analysis without one predates the farms, and the
 * old images carried every package. The heal gives it the same reach again — it
 * links the whole closure that the catalog farm records, and the lock of the
 * healed farm is the catalog `inflexa.lock` VERBATIM. Thus the advertised
 * inventory equals the linked content, and the warm records ride.
 *
 * The composition builds into a dot-staging directory beside the farms and
 * publishes with one rename, thus a crash leaves a dot-directory that every
 * scanner skips, and the analysis stays farm-less until the next trigger. A
 * present farm returns unchanged, and that check runs INSIDE the mutex, thus
 * two concurrent heals serialize and the second serves the published farm.
 *
 * It yields to a live reclamation, because it links pool content — refer to
 * {@link underFarmMutex}.
 */
export async function composeFullFarm(
    params: { readonly storeRoot: string; readonly analysisId: string },
    deps: FarmCompositionDeps = {},
): Promise<Result<FarmComposition, FarmCompositionError>> {
    const farmPath = analysisFarmPath(params.storeRoot, params.analysisId);
    const catalogLock = join(params.storeRoot, FARMS_DIR, CATALOG_FARM, FARM_LOCK_FILE);
    const stagePath = join(params.storeRoot, FARMS_DIR, `.heal-${params.analysisId}`);
    const made = await underFarmMutex(params.analysisId, reclaimYield(deps), () => {
        if (existsSync(join(farmPath, FARM_LOCK_FILE))) {
            const lock = readOwnLock(farmPath);
            return ok<FarmComposition, FarmCompositionError>({
                farmPath,
                roots: lock === null ? [] : lock.packages.filter((entry) => entry.requested).map((entry) => entry.store_dir),
                storeDirs: lock === null ? [] : lock.packages.map((entry) => entry.store_dir),
                added: [],
                tracks: [],
            });
        }
        return readTemplate(params.storeRoot).andThen((template) =>
            readDepsGraph(params.storeRoot).andThen((graph) => {
                const closure = readFarmClosure(join(params.storeRoot, FARMS_DIR, CATALOG_FARM));
                const roots = readFarmRoots(join(params.storeRoot, FARMS_DIR, CATALOG_FARM));
                // The catalog and the graph publish together. A catalog member that
                // the graph does not hold would link short, thus the walk refuses.
                const unknown = [...closure].filter((key) => !graph.nodes.has(key)).sort();
                if (unknown.length > 0) return err<FarmComposition, FarmCompositionError>({ type: "unknown_root", roots: unknown });
                return tryFs("make the staging farm", () => {
                    // A dot-directory from a crashed heal is debris, and a farm
                    // directory WITHOUT a lock is one too: the mount gate refuses
                    // it, and the rename below needs the slot free.
                    rmSync(stagePath, { recursive: true, force: true });
                    rmSync(farmPath, { recursive: true, force: true });
                    mkdirSync(stagePath, { recursive: true });
                })
                    .andThen(() => linkClosure(params.storeRoot, stagePath, graph, closure, template, roots))
                    .andThen((composed) =>
                        tryFs("publish the healed farm", () => {
                            cpSync(catalogLock, join(stagePath, FARM_LOCK_FILE));
                            seedFarmCache(params.storeRoot, stagePath);
                            renameSync(stagePath, farmPath);
                        }).map(() => ({ ...composed, farmPath })),
                    );
            }),
        );
    });
    // The same channel that `makeEmptyFarm` writes: the resolver calls this heal
    // inside the harness, and the sandbox gate is the surface that names a failure.
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
                        linkClosure(params.storeRoot, farmPath, graph, closure, template, roots),
                    ),
                );
            }),
        ),
    );
}

/**
 * Remove the farm of an analysis.
 *
 * The removal takes the per-farm mutex only. Liveness against a live sandbox is
 * the job of the analysis delete gate, which reads the run state and the lock
 * holds BEFORE it reaches this call — the farm-composition spec names that gate,
 * and no lease record exists anywhere.
 *
 * An absent farm is a normal state, not an error: a farm that a user deleted by
 * hand leaves nothing to remove. The pool is untouched either way, and the
 * reclamation frees what no farm references.
 *
 * It does NOT yield to a live reclamation. It links nothing, thus it can hold no
 * link that resolves to nothing. It is also the orphan-farm reaper of the
 * reclamation itself, and a yield there would make the reclamation wait for its
 * own lock.
 */
export function removeAnalysisFarm(params: RemoveFarmParams): Promise<Result<FarmRemoval, FarmCompositionError>> {
    const farmPath = analysisFarmPath(params.storeRoot, params.analysisId);
    return underFarmMutex(params.analysisId, null, () => {
        if (!isHostDir(farmPath)) return ok<FarmRemoval, FarmCompositionError>({ farmPath, removed: false });
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

/**
 * The catalog farm on the host, at `<storeRoot>/farms/catalog`. The heal
 * triggers read its lock for presence, with the same naming rule as
 * {@link analysisFarmPath}.
 */
export function catalogFarmPath(storeRoot: string): string {
    return join(storeRoot, FARMS_DIR, CATALOG_FARM);
}

// --- The two seam realizations ------------------------------------------------

/**
 * The sandbox nests the farm bind and the cache bind INSIDE the read-only
 * store bind, thus the kernel must find their mountpoint entries in the
 * store root. crun makes a missing mountpoint itself, but runc refuses that
 * mkdir inside a read-only mount, and the engine then refuses the whole
 * sandbox. Empty host-side entries remove the class for every engine.
 * `farm` serves the image toolchain, and `current` serves the old images
 * (see farmContainerPath in the harness mount plan). A failure only warns,
 * because a crun engine runs without the entries.
 *
 * The writer of a store root owns its mountpoints: the catalog download makes
 * the entries when it lands a root, because the published artifact carries
 * none and a consumer that only downloads has no other writer. The farm
 * resolver makes them again at sandbox create, as the heal for an entry that
 * a user removed by hand.
 */
export function ensureStoreMountpoints(storeRoot: string): void {
    for (const entry of ["farm", "current", "cache"] as const) {
        try {
            mkdirSync(join(storeRoot, entry), { recursive: true });
        } catch (cause) {
            getLogger("store").warn({ err: cause, storeRoot, entry }, "could not make the mountpoint entry; a runc engine can refuse the sandbox mounts");
        }
    }
}

/**
 * The farm-source resolver that the composition root binds
 * (`farmSource: { kind: "per-analysis" }`): an analysis id in, the farm location
 * out.
 *
 * The farm is made WITH its analysis, and it starts empty. Thus the ordinary
 * answer here is one `stat` of a path that is already there, and the resolver
 * composes nothing: the packages of a farm come from the plan of the analysis and
 * from the steps, which name them long before and long after this call.
 *
 * A MISSING farm is the pre-release discriminator, and the resolver is the
 * backstop of the heal: it composes the FULL farm from the catalog closure
 * ({@link composeFullFarm}), for a sandbox that no analysis open preceded. An
 * empty heal here would consume the discriminator, and the analysis would lose
 * the everything-available reach of the old images forever.
 *
 * The location carries the read-write cache of the farm beside it, thus the
 * sandbox mounts the cache at `/mnt/libs/cache` and a warm entry persists between
 * the runs of one analysis.
 *
 * A failure resolves as `unavailable` with its reason. The harness then refuses
 * that one sandbox with `farm_unavailable`, which is a refusal of one action and
 * never a boot failure.
 */
export async function resolveAnalysisFarm(storeRoot: string, analysisId: string): Promise<FarmResolution> {
    ensureStoreMountpoints(storeRoot);
    const farmPath = analysisFarmPath(storeRoot, analysisId);
    if (existsSync(join(farmPath, FARM_LOCK_FILE))) {
        // The cache directory can be gone when a user removed it by hand. The
        // mount of a missing host path would make it as root inside the engine,
        // thus the resolver re-makes it here, as this user.
        seedFarmCache(storeRoot, farmPath);
        return { kind: "available", location: { farmPath, cachePath: join(farmPath, FARM_CACHE_DIR) } };
    }
    const made = await composeFullFarm({ storeRoot, analysisId });
    return made.match(
        (farm): FarmResolution => ({ kind: "available", location: { farmPath: farm.farmPath, cachePath: join(farm.farmPath, FARM_CACHE_DIR) } }),
        (error): FarmResolution => ({ kind: "unavailable", reason: describeFarmCompositionError(error) }),
    );
}

/**
 * Whether the store could ever acquire one request. Acquisition covers the PyPI
 * index and the pak repositories (CRAN and Bioconductor), thus each ecosystem
 * answers true. The field exists for a later host whose store cannot acquire.
 */
function acquisitionPossible(): boolean {
    return true;
}

/**
 * The `absent` outcome of one request that did not resolve, in the vocabulary of the seam.
 *
 * The outcome echoes the REQUESTED spelling, never the canonical form. The caller
 * quotes this name into a remedy (`inflexa store add <name>`), and an R installer
 * needs the exact spelling — a canonical echo would teach the caller `go-db`.
 */
function absentOutcome(request: PackageRequest, failure: RequestResolutionError): PackageRequestOutcome {
    switch (failure.type) {
        case "unknown_distribution":
        case "unknown_version":
            return { kind: "absent", name: request.name, acquisitionPossible: acquisitionPossible() };
        case "ambiguous_ecosystem":
            // The pair is terminal for the request: only its caller can name the
            // ecosystem. The two store directories ride back as the guidance.
            return { kind: "collision", name: request.name, storeDirs: failure.candidates };
        default: {
            const unreachable: never = failure;
            throw new Error(`unhandled resolution failure: ${JSON.stringify(unreachable)}`);
        }
    }
}

/**
 * The farm-extension seam realization (`link_packages`): the requests of one
 * sandbox step in, one outcome for each request out, in the order of the requests.
 *
 * The seam runs in THIS process, beside the tool that calls it. It reads the
 * graph, it resolves each request against the pool, and it links what resolved.
 * Thus it starts no container, it opens no network connection, and it starts no
 * `inflexa` child: an acquisition is a host action, behind its own approval, and
 * it is never a step of a run.
 *
 * The graph is read ONE time for the whole batch, and the extension is one call
 * under the per-farm mutex that {@link extendFarm} takes. A refusal refuses the
 * whole batch, because the link pass plans the whole extension before it writes
 * anything.
 */
export async function linkPackagesIntoFarm(
    storeRoot: string,
    analysisId: string,
    requests: readonly PackageRequest[],
): Promise<readonly PackageRequestOutcome[]> {
    const read = readDepsGraph(storeRoot);
    if (read.isErr()) {
        // A store with no readable graph answers NOTHING about presence, thus
        // each request reports `unavailable` with the one graph reason. A bare
        // "absent" here would be a fabrication: it sends the agent after
        // packages the pool holds, while the true fault sits in the graph.
        const reason = describeFarmCompositionError(read.error);
        // The requested spelling rides back, because a caller quotes it into a remedy.
        return requests.map((request) => ({ kind: "unavailable", name: request.name, reason }));
    }
    const graph = read.value;

    const resolutions = requests.map((request) => ({ request, resolved: resolvePackageRequest(graph, request) }));
    const roots = [
        ...new Set(
            resolutions.flatMap(({ resolved }) =>
                resolved.match(
                    (answer) => [answer.storeDir],
                    () => [],
                ),
            ),
        ),
    ];

    // The closure of the farm BEFORE the extension, which is what tells `present`
    // from `linked`. A batch that resolved nothing extends nothing, thus it reads
    // nothing.
    const linkedAlready = roots.length === 0 ? new Set<string>() : readFarmClosure(analysisFarmPath(storeRoot, analysisId));
    const extended = roots.length === 0 ? null : await extendFarm({ storeRoot, analysisId, roots });

    return resolutions.map(({ request, resolved }) =>
        resolved.match(
            (answer): PackageRequestOutcome => {
                if (extended === null || extended.isOk()) {
                    // The requested spelling rides back — the caller reads its own vocabulary.
                    return { kind: linkedAlready.has(answer.storeDir) ? "present" : "linked", name: request.name, version: answer.version };
                }
                const error = extended.error;
                // A version collision names the two store directories WITH their
                // dependents, and the tool reports both and stops. Each resolved
                // request of the batch carries it, because the extension refused
                // whole and the farm stayed exactly as it was. Every other
                // extension error reports `unavailable` with its reason — a
                // locked farm or a failed write says nothing about presence, and
                // an "absent" there would misdirect the caller into asks.
                return error.type === "version_collision"
                    ? { kind: "collision", name: error.name, storeDirs: [error.existing, error.incoming], detail: describeFarmCompositionError(error) }
                    : { kind: "unavailable", name: request.name, reason: describeFarmCompositionError(error) };
            },
            (failure) => absentOutcome(request, failure),
        ),
    );
}
