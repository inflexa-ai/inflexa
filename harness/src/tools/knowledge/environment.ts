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
 * Absence is data: a package the farm lacks reads `present: false`, and a
 * collection the store lacks reads `present: false`. The join never fills a
 * gap and never names a path it did not read.
 */

import { readFarmLockFile } from "../../sandbox/farm.js";
import { readReferenceInventory, type ReferenceInventoryEntry } from "../sandbox/list-available-refs.js";
import type { RecommendResponse } from "./client.js";

export interface EnvironmentPaths {
    /** Host path of the farm `inflexa.lock`. Absent, the packages read as unknown. */
    readonly farmLockFile?: string;
    /** Host path of the reference store. Absent, the collection reads as unknown. */
    readonly refStorePath?: string;
}

export interface StepEnvironment {
    readonly package?: { readonly name: string; readonly present: boolean; readonly version?: string };
    readonly collection?: { readonly name: string; readonly present: boolean; readonly path?: string; readonly title?: string };
}

/** The recommend answer with an `environment` per step. */
export type RecommendWithEnvironment = RecommendResponse & {
    readonly environment_source?: { readonly farm: "lock" | "unknown"; readonly references: "store" | "unknown" };
    readonly procedure: readonly (RecommendResponse["procedure"][number] & { readonly environment?: StepEnvironment })[];
};

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
    const lock = paths.farmLockFile ? readFarmLockFile(paths.farmLockFile) : undefined;
    const farm = lock && lock.isOk() ? new Map(lock.value.packages.map((pkg) => [pkg.name.toLowerCase(), pkg.version])) : undefined;
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
        environment_source: { farm: farm ? "lock" : "unknown", references: entries ? "store" : "unknown" },
    };
}
