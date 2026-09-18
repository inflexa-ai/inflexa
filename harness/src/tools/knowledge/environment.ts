/**
 * The environment join of a procedure: which package of each step the farm
 * holds, at which version, and which collection of the reference store the
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
 * Absence is data: a package neither record names reads `present: false`,
 * and a collection the store lacks reads `present: false`. The join never
 * fills a gap and never names a path it did not read.
 */

import { readFarmLockFile } from "../../sandbox/farm.js";
import { readImagePackagesFile } from "../../sandbox/image-packages.js";
import { readReferenceInventory, type ReferenceInventoryEntry } from "../sandbox/list-available-refs.js";
import type { FarmPackage, RecommendResponse } from "./client.js";

export interface EnvironmentPaths {
    /** Host path of the farm `inflexa.lock`. Absent, the packages read as unknown. */
    readonly farmLockFile?: string;
    /** Host path of the `image-packages.json` of the store. Absent, the packages the image ships are unknown. */
    readonly imagePackagesFile?: string;
    /** Host path of the reference store. Absent, the collection reads as unknown. */
    readonly refStorePath?: string;
}

export interface StepEnvironment {
    readonly package?: { readonly name: string; readonly present: boolean; readonly version?: string };
    readonly collection?: { readonly name: string; readonly present: boolean; readonly path?: string; readonly title?: string };
}

/** Where each fact of the environment came from: a record the host read, or nothing. */
export interface EnvironmentSource {
    readonly farm: "lock" | "unknown";
    /** `record` when the store carries the `image-packages.json` of the sandbox image. */
    readonly image: "record" | "unknown";
    readonly references: "store" | "unknown";
}

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
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 1);
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

export async function joinEnvironment(answer: RecommendResponse, paths: EnvironmentPaths): Promise<RecommendWithEnvironment> {
    if (answer.match !== "applicable" && answer.match !== "flag") return answer;
    const installed = installedPackages(paths);
    const farm = installed.packages ? new Map(installed.packages.map((pkg) => [pkg.name.toLowerCase(), pkg.version])) : undefined;
    const inventory = paths.refStorePath ? await readReferenceInventory(paths.refStorePath).catch(() => undefined) : undefined;
    const entries = inventory?.available ? inventory.entries : undefined;

    const procedure = answer.procedure.map((step) => {
        const environment: { package?: StepEnvironment["package"]; collection?: StepEnvironment["collection"] } = {};
        const pkg = (step as { package?: { name: string } }).package;
        if (pkg && farm) {
            const version = farm.get(pkg.name.toLowerCase());
            environment.package = { name: pkg.name, present: version !== undefined, ...(version !== undefined ? { version } : {}) };
        }
        const collection = step.parameters?.find((parameter) => parameter.name === "gene_set_collection");
        if (collection && typeof collection.value === "string" && entries) {
            const found = findCollection(collection.value, entries);
            environment.collection = {
                name: collection.value,
                present: found !== undefined,
                ...(found ? { path: found.path } : {}),
                ...(found?.metadata?.title ? { title: found.metadata.title } : {}),
            };
        }
        return Object.keys(environment).length > 0 ? { ...step, environment } : step;
    });
    return {
        ...answer,
        procedure,
        environment_source: { farm: installed.farm, image: installed.image, references: entries ? "store" : "unknown" },
    };
}
