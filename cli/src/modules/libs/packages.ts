/**
 * The baked image inventory fragment, cached on the host.
 *
 * The runtime image advertises its two image-owned tracks — the bioconda
 * command-line tools and the Node packages — through a fragment baked at
 * `/opt/inflexa/image-packages.txt`. `list_available_packages` merges that
 * fragment with the farm `inflexa.lock` of the analysis. The host cannot see
 * the container path, thus this module extracts the fragment one time for each
 * image and caches it on the host.
 *
 * The farm side of the inventory needs no host work: the composer writes the
 * lock of each farm, and the harness tool reads it by path. The POOL side
 * lives here too: `readPoolInventorySections` reads the graph, and the
 * conversation agent and the planner answer package presence from it.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { PoolInventoryPackage, PoolInventorySection } from "@inflexa-ai/harness";

import { capture, type ContainerRuntime } from "../../lib/container.ts";
import { mkdirResult, writeFileResult } from "../../lib/fs.ts";
import { readDepsGraph } from "./composition.ts";

/** The container path of the baked inventory fragment inside the runtime image. */
const IMAGE_PACKAGES_PATH = "/opt/inflexa/image-packages.txt";

/**
 * Extract the runtime image's baked inventory fragment and cache it on the host, keyed by the local image
 * digest. The function gives the host path of the cache file, or `null` when it cannot extract the
 * fragment.
 *
 * The local image digest keys the cache. A cache hit reads the file and runs no container. A cache miss
 * extracts the fragment with the entrypoint set to `cat`. A pull of a new image gives a new digest, thus
 * the cache refreshes itself.
 *
 * `null` is a normal state, not an error. The tool then reports the farm tracks alone. A failed digest
 * read, a non-zero exit, or a failed write each give `null`, so an extraction failure never fails the
 * boot.
 */
export async function imagePackagesFile(rt: ContainerRuntime, image: string, cacheDir: string): Promise<string | null> {
    // `capture` THROWS when the runtime binary is not on PATH (ENOENT from spawn). An absent container
    // runtime is an ordinary state for a host that has not provisioned one yet, and the fragment is an
    // enrichment, so the throw is bridged here rather than allowed to escape into the boot sequence.
    const probe = async (args: string[]): Promise<{ code: number; stdout: string } | null> => {
        try {
            return await capture(rt, args);
        } catch {
            return null;
        }
    };

    // The LOCAL image digest keys the cache. `image inspect --format {{.Id}}` gives it, and a non-zero
    // exit means the image is absent from this runtime — then there is nothing to extract.
    const inspected = await probe(["image", "inspect", "--format", "{{.Id}}", image]);
    if (inspected === null || inspected.code !== 0) return null;
    const digest = inspected.stdout.trim();
    if (digest === "") return null;

    // One cache file for each digest. The digest carries a colon (`sha256:...`), so replace each
    // character that a file name cannot carry.
    const cachePath = join(cacheDir, `${digest.replace(/[^A-Za-z0-9]+/g, "-")}.txt`);
    if (existsSync(cachePath)) return cachePath;

    // A cache miss extracts the fragment. A non-zero exit means the image has no fragment (an older
    // image), and the fragment degrades to null.
    const extracted = await probe(["run", "--rm", "--entrypoint", "cat", image, IMAGE_PACKAGES_PATH]);
    if (extracted === null || extracted.code !== 0) return null;

    // A write failure degrades to null, exactly as an extraction failure does.
    const dirMade = mkdirResult(cacheDir, "make the image-package cache directory");
    if (dirMade.isErr()) return null;
    const written = writeFileResult(cachePath, extracted.stdout, "write the image-package cache");
    if (written.isErr()) return null;
    return cachePath;
}

// --- The pool-scope inventory ---------------------------------------------------

/** The section title of each graph track, in the vocabulary of the inventory tool. */
const POOL_TRACK_TITLES: Record<string, string> = { python: "Python (pip)", r: "R" };

/**
 * Read the full content hash a store directory records. The marker sits at the
 * top level for a Python directory, and one level down for an R directory —
 * the same nesting `store ls` reads the pin through. Absent reads as
 * `undefined`, and the entry simply carries no hash.
 */
async function readHashMarker(storeDir: string): Promise<string | undefined> {
    const candidates = [join(storeDir, ".inflexa-hash")];
    try {
        for (const entry of await readdir(storeDir, { withFileTypes: true })) {
            if (entry.isDirectory()) candidates.push(join(storeDir, entry.name, ".inflexa-hash"));
        }
    } catch {
        return undefined;
    }
    for (const candidate of candidates) {
        try {
            const first = (await readFile(candidate, "utf8")).split("\n", 1)[0]?.trim() ?? "";
            if (first !== "") return first;
        } catch {
            continue;
        }
    }
    return undefined;
}

/**
 * The pool-scope inventory for `list_available_packages`: every distribution
 * the graph advertises, at its newest pin, with the store identity of that
 * pin. The conversation agent and the planner read THIS view, because their
 * question is "what does the store hold", and the farm of a new analysis is
 * empty — a farm view there reads every pool package as absent.
 *
 * `null` means the graph cannot be read, and the tool then reports the set
 * as UNKNOWN. An absent graph is a store that advertises nothing yet, and
 * UNKNOWN is the honest answer for it too.
 */
export async function readPoolInventorySections(storeRoot: string): Promise<readonly PoolInventorySection[] | null> {
    const graph = readDepsGraph(storeRoot);
    if (graph.isErr()) return null;
    const sections: PoolInventorySection[] = [];
    for (const [track, title] of Object.entries(POOL_TRACK_TITLES)) {
        const shelf = graph.value.byName[track as keyof typeof graph.value.byName];
        if (shelf === undefined || shelf.size === 0) continue;
        const packages: PoolInventoryPackage[] = [];
        for (const [name, dirs] of [...shelf.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            // The head of the shelf is the newest pin — the emitter settles that
            // order, and a request that names no version takes exactly this head.
            const head = dirs[0];
            if (head === undefined) continue;
            const node = graph.value.nodes.get(head);
            const hash = await readHashMarker(join(storeRoot, "store", head));
            packages.push({
                name: node?.name ?? name,
                ...(node?.version === undefined ? {} : { version: node.version }),
                storeDir: head,
                ...(hash === undefined ? {} : { hash }),
            });
        }
        if (packages.length > 0) sections.push({ title, packages });
    }
    return sections;
}
