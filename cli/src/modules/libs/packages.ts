/**
 * The pool-scope package inventory of the store.
 *
 * `list_available_packages` answers from two views. The farm side needs no host
 * work: the composer writes the lock of each farm, and the harness tool reads it
 * by path. The POOL side lives here. `readPoolInventorySections` reads the
 * dependency graph of the store, and the conversation agent and the planner
 * answer package presence from it, because their question is what the store
 * holds and not what one farm links.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { PoolInventoryPackage, PoolInventoryRead, PoolInventorySection, Track } from "@inflexa-ai/harness";

import { describeFarmCompositionError, readDepsGraph } from "./composition.ts";

/**
 * The section of each graph track: the track as DATA, and the title as display.
 * A `language` filter of the tool reads the track, thus a reworded heading
 * changes no answer.
 */
const POOL_TRACK_SECTIONS: readonly { readonly track: Track; readonly title: string }[] = [
    { track: "python", title: "Python (pip)" },
    { track: "r", title: "R" },
];

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
 * An unreadable graph reads as `unavailable` WITH the graph reason, and the
 * tool reports the set as UNKNOWN plus that reason. The reason is the whole
 * point: a dangling edge is a structural fault, and without the cause the
 * agent reads the state as a transient flake and retries without end. An
 * absent graph is a store that advertises nothing yet, and it carries the
 * same honest answer.
 */
export async function readPoolInventorySections(storeRoot: string): Promise<PoolInventoryRead> {
    const graph = readDepsGraph(storeRoot);
    if (graph.isErr()) return { kind: "unavailable", reason: describeFarmCompositionError(graph.error) };
    const sections: PoolInventorySection[] = [];
    for (const { track, title } of POOL_TRACK_SECTIONS) {
        const shelf = graph.value.byName[track];
        if (shelf.size === 0) continue;
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
        if (packages.length > 0) sections.push({ title, track, packages });
    }
    return { kind: "sections", sections };
}
