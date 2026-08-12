/**
 * The package inventory `list_available_packages` reads, resolved on the host.
 *
 * The inventory has two sources. The store the sandbox mounts gives the first
 * source. The runtime image gives the second source. The rule is that the
 * inventory describes what the sandbox can carry, because an agent that is told a
 * package exists, when the mount cannot carry it, writes code that fails at
 * import.
 *
 * The store answer is the POOL and never one farm. Each analysis mounts the farm
 * that composition made for it, and composition links any pool package on demand.
 * Thus the pool is what planning selects from, and the farm is what the sandbox
 * that ran already holds. `storePackagesFile` derives that pool inventory.
 *
 * The runtime image bakes a fragment that lists the two image-owned tracks, which
 * are the bioconda command-line tools and the Node packages. The host cannot see
 * that container path. Thus `imagePackagesFile` extracts the fragment one time for
 * each image and caches it on the host.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { capture, type ContainerRuntime } from "../../lib/container.ts";
import { mkdirResult, readFileResult, renameResult, statResult, writeFileResult } from "../../lib/fs.ts";
import { INVENTORY_HEADER, INVENTORY_ORDER, INVENTORY_TRACKS, nameOfStoreDir, readDepsGraph, type DepsGraph } from "./composition.ts";

/** The dependency graph at the store root. It names every store directory that composition can link. */
const STORE_GRAPH = "deps.json";

/** The pool inventory, at the store root. The name and the shape are the ones the shared producer fixes. */
const POOL_INVENTORY = "packages.txt";

/** The catalog template farm, whose own inventory carries the true section of each name that it lists. */
const TEMPLATE_INVENTORY = join("farms", "catalog", POOL_INVENTORY);

/** Where a name that the template does not list goes, by the track that the graph records for it. */
const TRACK_SECTION: Readonly<Record<"python" | "r", string>> = {
    python: INVENTORY_TRACKS.python.title,
    // The graph records no R subtree, and the composer links an R store directory
    // that the template does not place into `cran` for the same reason. Thus the two
    // agree on where an R package that arrived after the catalog belongs.
    r: INVENTORY_TRACKS.cran.title,
};

/**
 * The pool inventory of the store, or `null` when the store can serve no package.
 *
 * The answer is the pool, because composition links from the pool on demand: a
 * package that the pool holds and that no farm links yet is still a package that
 * planning can select. The graph `deps.json` names exactly that set, thus the graph
 * is the source. A store directory that the graph does not name is unreachable for
 * composition, and it stays out of the inventory for that reason.
 *
 * The result is a FILE, because the harness tool reads a host path. Nothing else
 * writes a store-level inventory today: the provisioner writes one for each farm,
 * and the merge of the download brings the farms and the graph. Thus this derives
 * one and it caches it at the store root, beside the graph it describes. The tool
 * re-reads that file at each call, so a store that grows reaches the next call with
 * no restart.
 *
 * The derivation runs only when the graph, or the inventory of the template, is
 * newer than the cache. The gate polls this every few seconds, thus the common path
 * is three `stat` calls and no read.
 *
 * `null` is the state that the sandbox gate refuses on, and it stays exact: a store
 * with no graph, or a graph that names no package, can compose no farm, thus a
 * sandbox of it could import nothing.
 */
/**
 * Why {@link storePackagesFile} gives no inventory. It separates two conditions that
 * want two different remedies.
 *
 * `no_graph` is the store of the layout that came before the graph. Its pool and its
 * farms are complete, and its receipt pins the catalog that it installed. Thus
 * `inflexa store download` resolves the same digest and transfers nothing, and only
 * the `--update` consent replaces the catalog. A remedy that names the bare command
 * sends the user into a loop.
 *
 * `no_packages` is a graph that names nothing, which a damaged or empty store gives.
 */
export type PoolInventoryGap = "no_graph" | "no_packages";

/**
 * The reason that the store carries no pool inventory, for a message that names the
 * correct remedy. It re-stats the graph rather than share the work of
 * {@link storePackagesFile}, because it runs on the failure path only.
 */
export function poolInventoryGap(storePath: string): PoolInventoryGap {
    return statResult(join(storePath, STORE_GRAPH), "stat the dependency graph").isErr() ? "no_graph" : "no_packages";
}

export function storePackagesFile(storePath: string): string | null {
    const graph = statResult(join(storePath, STORE_GRAPH), "stat the dependency graph");
    if (graph.isErr()) return null;
    const inventory = join(storePath, POOL_INVENTORY);
    const template = statResult(join(storePath, TEMPLATE_INVENTORY), "stat the template inventory");
    const cached = statResult(inventory, "stat the pool inventory");

    const newest = Math.max(graph.value.mtimeMs, template.isOk() ? template.value.mtimeMs : 0);
    if (cached.isOk() && cached.value.mtimeMs >= newest) return inventory;

    const derived = derivePoolInventory(storePath);
    if (derived === null) return null;
    // A store root that this process cannot write is a real condition (a read-only
    // volume, a permission), and it must not read as an empty store. The stale cache
    // is then the honest answer, because it still describes packages that the pool
    // holds.
    return writePoolInventory(storePath, inventory, derived) ? inventory : cached.isOk() ? inventory : null;
}

/**
 * The pool inventory as text, or `null` when the graph names no package.
 *
 * The GRAPH decides the set, and nothing else does. A name that only the template
 * carries is a name that composition cannot link, thus a store whose graph and farms
 * disagree reports the graph and never the farm.
 *
 * The template decides the SECTION and the SPELLING of each name that it already
 * lists. It was written from the farm itself, thus it knows which R subtree a
 * catalog package belongs to, and it spells a Python name as its `.dist-info` does
 * where the store-directory name carries the canonical form. A name that the
 * template does not list arrived after the catalog, and it joins the section of its
 * track.
 */
function derivePoolInventory(storePath: string): string | null {
    const graph = readDepsGraph(storePath);
    if (graph.isErr()) return null;

    const template = readTemplateSections(storePath);
    const placed = new Map<string, { readonly title: string; readonly name: string }>();
    for (const [title, names] of template) for (const name of names) placed.set(canonicalName(name), { title, name });

    // The titles of the template seed the order, thus the sections come out in the
    // order the shared producer writes them.
    const sections = new Map<string, string[]>([...template.keys()].map((title) => [title, []]));
    let listed = 0;
    for (const [name, track] of poolNames(graph.value)) {
        const known = placed.get(canonicalName(name));
        const title = known?.title ?? TRACK_SECTION[track];
        sections.set(title, [...(sections.get(title) ?? []), known?.name ?? name]);
        listed += 1;
    }
    if (listed === 0) return null;

    let body = INVENTORY_HEADER;
    for (const [title, names] of sections) {
        if (names.length === 0) continue;
        body += `## ${title}\n${[...new Set(names)].sort().join(", ")}\n\n`;
    }
    return body;
}

/** The distribution name and the track of each store directory that the graph names. */
function poolNames(graph: DepsGraph): [string, "python" | "r"][] {
    const names: [string, "python" | "r"][] = [];
    for (const [storeDir, node] of graph.nodes) {
        if (node.track === "r") {
            if (node.rDir !== null) names.push([node.rDir, "r"]);
            continue;
        }
        const name = nameOfStoreDir(storeDir);
        if (name !== null) names.push([name, "python"]);
    }
    return names;
}

/**
 * The sections of the template inventory, in the order it wrote them, or the empty
 * canonical order when the store carries no template.
 *
 * The parse is the one the harness tool uses: a `##` line opens a section, a `#`
 * line is advisory, and every other line contributes comma-separated names.
 */
function readTemplateSections(storePath: string): Map<string, string[]> {
    const sections = new Map<string, string[]>();
    const raw = readFileResult(join(storePath, TEMPLATE_INVENTORY), "read the template inventory");
    if (raw.isErr()) {
        // No template: the canonical order decides the sections, so a store built by
        // acquisition alone presents the same shape as a store built by a download.
        for (const track of INVENTORY_ORDER) sections.set(INVENTORY_TRACKS[track].title, []);
        return sections;
    }
    let open: string | null = null;
    for (const line of raw.value.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        if (trimmed.startsWith("##")) {
            open = trimmed.slice(2).trim();
            if (!sections.has(open)) sections.set(open, []);
            continue;
        }
        if (trimmed.startsWith("#") || open === null) continue;
        sections.get(open)?.push(
            ...trimmed
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name !== ""),
        );
    }
    return sections;
}

/** The canonical form of a distribution name, so two spellings of one package count one time. */
function canonicalName(name: string): string {
    return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/**
 * Publish the derived inventory at the store root, and report whether it landed.
 *
 * The write goes to a per-process temporary name and a rename publishes it, thus a
 * reader sees the old inventory or the new one and never a part of one, and two
 * processes that derive at the same time never share a temporary file.
 */
function writePoolInventory(storePath: string, inventory: string, body: string): boolean {
    const temp = join(storePath, `.${POOL_INVENTORY}.${process.pid}.tmp`);
    return writeFileResult(temp, body, "write the pool inventory")
        .andThen(() => renameResult(temp, inventory, "publish the pool inventory"))
        .isOk();
}

/** The container path of the baked inventory fragment inside the runtime image. */
const IMAGE_PACKAGES_PATH = "/opt/inflexa/image-packages.txt";

/**
 * Extract the runtime image's baked inventory fragment and cache it on the host, keyed by the local image
 * digest. The function gives the host path of the cache file, or `null` when it cannot extract the
 * fragment.
 *
 * The runtime image bakes the fragment at `/opt/inflexa/image-packages.txt`. The fragment lists the two
 * image-owned tracks, which are the bioconda command-line tools and the Node packages. The host cannot
 * see that container path. Thus the CLI runs the container with the entrypoint set to `cat` and captures
 * the file.
 *
 * The local image digest keys the cache. A cache hit reads the file and runs no container. A cache miss
 * extracts the fragment. A pull of a new image gives a new digest, thus the cache refreshes itself.
 *
 * `null` is a normal state, not an error. The tool then reports the store tracks alone. A failed digest
 * read, a non-zero exit, or a failed write each give `null`, so an extraction failure never fails the
 * boot.
 */
export async function imagePackagesFile(rt: ContainerRuntime, image: string, cacheDir: string): Promise<string | null> {
    // The LOCAL image digest keys the cache. `image inspect --format {{.Id}}` gives it, and a non-zero
    // exit means the image is absent from this runtime — then there is nothing to extract.
    const inspected = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]);
    const digest = inspected.stdout.trim();
    if (inspected.code !== 0 || digest === "") return null;

    // One cache file for each digest. A pull of a new image gives a new digest, thus a new cache file,
    // thus the cache refreshes itself. The digest carries a colon (`sha256:...`), so replace each
    // character that a file name cannot carry.
    const cachePath = join(cacheDir, `${digest.replace(/[^A-Za-z0-9]+/g, "-")}.txt`);
    // A cache hit reads the file and runs no container.
    if (existsSync(cachePath)) return cachePath;

    // A cache miss extracts the fragment. The host cannot see the container path, so run the container
    // with the entrypoint set to `cat`. A non-zero exit means the image has no fragment (an older image),
    // and the fragment degrades to null.
    const extracted = await capture(rt, ["run", "--rm", "--entrypoint", "cat", image, IMAGE_PACKAGES_PATH]);
    if (extracted.code !== 0) return null;

    // Write the fragment to the cache. A write failure degrades to null, exactly as an extraction failure
    // does, so a boot never fails on it.
    const dirMade = mkdirResult(cacheDir, "make image-package cache dir");
    if (dirMade.isErr()) return null;
    const written = writeFileResult(cachePath, extracted.stdout, "write image-package cache");
    if (written.isErr()) return null;
    return cachePath;
}
