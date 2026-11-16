/**
 * The environment join of a procedure: where the package of each step stands,
 * at which version, and which collection of the reference store the
 * enrichment step names. The service knows the methods and the collections
 * by name; the host knows what is installed. Joined here, the answer of
 * `knowledge_recommend` carries the environment, and a planner has no reason
 * to call the listing tools for the packages and the collection it was told
 * to use. A model that hunts for what it already has was the cost of the
 * Phase 0 campaigns on a small model.
 *
 * The installed packages come from two records the host reads, never from a
 * list in the code: the `inflexa.lock` of the farm names the packages the
 * store links, and the `image-packages.json` of the store names what the
 * sandbox image itself ships, among them the R packages of the R runtime
 * (`stats`, `survival`, `MASS`), which no farm lock lists. Both records are
 * written by their producers and validated here.
 *
 * A package has one of three states. `installed`: one of the two records
 * names it, thus the sandbox loads it now. `in_store`: the pool-scope
 * inventory of the package store holds it, thus the launch links it into the
 * farm when the step names it in `packages`. `absent`: the sandbox and the
 * store both lack it. The farm of an analysis links only what its plans
 * named, thus the farm alone cannot tell "absent" from "not linked yet".
 *
 * Absence is data, and an unknown is not an absence: a package that no
 * record names gets no state when the host could not read the store, and a
 * collection the store lacks reads `present: false`. The join never fills a
 * gap and never names a path it did not read.
 */

import type { EnvironmentStorePaths, PoolInventoryRead, PoolInventorySection } from "../../config/environment-stores.js";
import { readFarmLockFile } from "../../sandbox/farm.js";
import { readImagePackagesFile } from "../../sandbox/image-packages.js";
import { formatQuery, identityOf, type Track } from "../../sandbox/package-identity.js";
import { bothTrackNames, DEFAULT_IMAGE_PACKAGES_FILE, queryPackages, trackOfLockSubtree } from "../sandbox/list-available-packages.js";
import { readReferenceInventory, type ReferenceInventoryEntry } from "../sandbox/list-available-refs.js";
import type { FarmPackage, RecommendResponse } from "./client.js";

export type EnvironmentPaths = {
    /** Host path of the farm `inflexa.lock`. Absent, the packages read as unknown. */
    readonly farmLockFile?: string;
    /**
     * Host path of the `image-packages.json` of the store. Absent, the join
     * reads the record at the container mountpoint of the store, as
     * `list_available_packages` does, and `installedPackages` reads none.
     */
    readonly imagePackagesFile?: string;
    /** Host path of the reference store. Absent, the collection reads as unknown. */
    readonly refStorePath?: string;
    /**
     * The pool-scope inventory of the package store: what a launch can link
     * into the farm. Absent or unavailable, a package that the sandbox does
     * not hold gets no state.
     */
    readonly readPoolInventory?: EnvironmentStorePaths["readPoolInventory"];
};

/** Where the package of a step stands: loaded by the sandbox now, held by the store for the launch to link, or in neither. */
export type PackageState = "installed" | "in_store" | "absent";

export type StepEnvironment = {
    readonly package?: {
        readonly name: string;
        readonly state: PackageState;
        readonly version?: string;
        /**
         * The `packages` entry of the step, with its track, when the store
         * holds the name in both tracks. A bare entry of such a name refuses
         * the launch.
         */
        readonly entry?: string;
    };
    readonly collection?: { readonly name: string; readonly present: boolean; readonly path?: string; readonly title?: string };
};

/** Where each fact of the environment came from: a record the host read, or nothing. */
export type EnvironmentSource = {
    readonly farm: "lock" | "unknown";
    /** `record` when the store carries the `image-packages.json` of the sandbox image. */
    readonly image: "record" | "unknown";
    /** `inventory` when the host read the pool-scope inventory of the package store. */
    readonly pool: "inventory" | "unknown";
    readonly references: "store" | "unknown";
};

/** The recommend answer with an `environment` per step. */
export type RecommendWithEnvironment = RecommendResponse & {
    readonly environment_source?: EnvironmentSource;
    readonly procedure: readonly (RecommendResponse["procedure"][number] & { readonly environment?: StepEnvironment })[];
};

/**
 * The packages installed in the sandbox, as the two records report them, with
 * one entry per name. The farm lock comes first and it wins a collision,
 * because a farm that links its own copy of a package is what a step loads.
 * `packages` is absent when neither record is readable, thus a caller sends
 * nothing to the knowledge service rather than an empty farm, and the answer
 * reads `unknown` instead of "absent".
 *
 * Of the image record only the R runtime track joins the list. The conda
 * tools and the Node packages of the image are not of the package tracks a
 * template pins, and a name of one of them must not answer for a package.
 *
 * The same list serves the environment join of the recommend answer and the
 * environment match of a rendered template, thus the two agree.
 */
export function installedPackages(paths: Pick<EnvironmentPaths, "farmLockFile" | "imagePackagesFile">): {
    readonly packages?: readonly FarmPackage[];
    readonly farm: EnvironmentSource["farm"];
    readonly image: EnvironmentSource["image"];
} {
    const lock = paths.farmLockFile ? readFarmLockFile(paths.farmLockFile).unwrapOr(undefined) : undefined;
    const record = paths.imagePackagesFile ? readImagePackagesFile(paths.imagePackagesFile).unwrapOr(undefined) : undefined;
    if (!lock && !record) return { farm: "unknown", image: "unknown" };
    const packages: FarmPackage[] = [];
    const seen = new Set<string>();
    for (const pkg of [...(lock?.packages ?? []), ...(record?.r_base ?? [])]) {
        const key = pkg.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        packages.push({ name: pkg.name, version: pkg.version });
    }
    return { packages, farm: lock ? "lock" : "unknown", image: record ? "record" : "unknown" };
}

function tokens(text: string): string[] {
    const tokens: string[] = [];
    let token = "";
    const flush = (): void => {
        if (token.length > 1) tokens.push(token);
        token = "";
    };
    for (const char of text.toLowerCase()) {
        if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) token += char;
        else flush();
    }
    flush();
    return tokens;
}

/** A collection term of the tree (`msigdb_hallmark_human`) matches an entry whose labels hold every token of the term. */
function findCollection(term: string, entries: readonly ReferenceInventoryEntry[]): ReferenceInventoryEntry | undefined {
    const wanted = tokens(term);
    if (wanted.length === 0) return undefined;
    const candidates = entries.filter((entry) => {
        const haystack = tokens([entry.path, entry.metadata?.datasetId ?? "", entry.metadata?.title ?? ""].join(" "));
        return wanted.every((token) => haystack.includes(token));
    });
    // A directory entry names the dataset; a file inside it is the concrete artifact. Prefer the file.
    return candidates.find((entry) => entry.kind === "file") ?? candidates[0];
}

/** The sections of the pool, or none when the host binds no reader or the reader cannot answer. */
async function readPool(read: EnvironmentPaths["readPoolInventory"]): Promise<readonly PoolInventorySection[] | undefined> {
    if (!read) return undefined;
    const pool = await read().catch((): PoolInventoryRead => ({ kind: "unavailable", reason: "the pool inventory could not be read" }));
    return pool.kind === "sections" ? pool.sections : undefined;
}

/** The pool track of the package of a step, from the track the service names (`bioconductor`, `cran`, `python`). */
function trackOf(pkg: { readonly name: string; readonly track?: unknown }): Track | undefined {
    return typeof pkg.track === "string" ? trackOfLockSubtree(pkg.track) : undefined;
}

/**
 * The lookup query of the package of a step. It names the track when the
 * service names one, thus the answer is for that package and not for a
 * package of the same name in the other track.
 */
function packageQuery(pkg: { readonly name: string; readonly track?: unknown }): string {
    const track = trackOf(pkg);
    return track === undefined ? pkg.name : formatQuery({ spelling: pkg.name, track });
}

/** What the pool holds for one query: the version of one package, or a bare name that both tracks hold. */
type PoolHold = { readonly kind: "held"; readonly version?: string } | { readonly kind: "both_tracks" };

/**
 * What the pool holds for each query, keyed by the query. The queries
 * resolve through the same lookup as `list_available_packages`, thus the
 * join and the census give one answer. A query with no entry is absent.
 */
function poolHolds(sections: readonly PoolInventorySection[], queries: readonly string[]): ReadonlyMap<string, PoolHold> {
    const holds = new Map<string, PoolHold>();
    if (queries.length === 0) return holds;
    const answer = queryPackages(sections, { names: queries });
    if (!("checked" in answer)) return holds;
    for (const entry of answer.checked) {
        if (!entry.present) continue;
        // A bare query answers once for each track that holds the name. Only a
        // name of no track can do that, because a track-qualified query
        // resolves to one identity.
        holds.set(entry.requested, holds.has(entry.requested) ? { kind: "both_tracks" } : { kind: "held", version: entry.version });
    }
    return holds;
}

export async function joinEnvironment(answer: RecommendResponse, paths: EnvironmentPaths): Promise<RecommendWithEnvironment> {
    if (answer.match !== "applicable" && answer.match !== "flag") return answer;
    // The record takes the default path of the census here only. A farm package that this read misses is in the pool,
    // thus it reads `in_store` and not `absent`. The template match sends the list as the whole farm, and a list from
    // the record alone would give false mismatches there.
    const installed = installedPackages({ farmLockFile: paths.farmLockFile, imagePackagesFile: paths.imagePackagesFile ?? DEFAULT_IMAGE_PACKAGES_FILE });
    const farm = installed.packages ? new Map(installed.packages.map((pkg) => [pkg.name.toLowerCase(), pkg.version])) : undefined;
    const pool = await readPool(paths.readPoolInventory);
    const queries = [...new Set(answer.procedure.flatMap((step) => (step.package ? [packageQuery(step.package)] : [])))];
    const stored = pool ? poolHolds(pool, queries) : undefined;
    const bothTracks = pool ? bothTrackNames(pool) : undefined;
    const inventory = paths.refStorePath ? await readReferenceInventory(paths.refStorePath).catch(() => undefined) : undefined;
    const entries = inventory?.available ? inventory.entries : undefined;

    const procedure = answer.procedure.map((step) => {
        const environment: { package?: StepEnvironment["package"]; collection?: StepEnvironment["collection"] } = {};
        const pkg = step.package;
        if (pkg) {
            const track = trackOf(pkg);
            // The launch refuses a bare entry of a name that both tracks hold, thus the step names the track.
            const entry = track !== undefined && bothTracks?.has(identityOf(track, pkg.name).name) ? packageQuery(pkg) : undefined;
            const withEntry = entry === undefined ? {} : { entry };
            const version = farm?.get(pkg.name.toLowerCase());
            const hold = stored?.get(packageQuery(pkg));
            if (version !== undefined) environment.package = { name: pkg.name, state: "installed", version, ...withEntry };
            else if (hold?.kind === "held") environment.package = { name: pkg.name, state: "in_store", version: hold.version, ...withEntry };
            // A bare name that both tracks hold names no one package, thus it gets no state.
            else if (stored && hold === undefined) environment.package = { name: pkg.name, state: "absent" };
        }
        const collection = step.parameters?.find((parameter) => parameter.name === "gene_set_collection");
        if (collection && typeof collection.value === "string" && entries) {
            const found = findCollection(collection.value, entries);
            environment.collection = {
                name: collection.value,
                present: found !== undefined,
                path: found?.path,
                title: found?.metadata?.title,
            };
        }
        return Object.keys(environment).length > 0 ? { ...step, environment } : step;
    });
    return {
        ...answer,
        procedure,
        environment_source: { farm: installed.farm, image: installed.image, pool: pool ? "inventory" : "unknown", references: entries ? "store" : "unknown" },
    };
}
