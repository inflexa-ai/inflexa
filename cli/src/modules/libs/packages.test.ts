import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nameOfStoreDir } from "./composition.ts";
import { imagePackagesFile, storePackagesFile } from "./packages.ts";
import * as container from "../../lib/container.ts";
import type { CaptureResult } from "../../lib/container.ts";

const IMAGE = "ghcr.io/inflexa-ai/sandbox-base:latest";
const DIGEST = "sha256:abc123";
/** `DIGEST` with each non-alphanumeric run replaced, plus the `.txt` suffix — the cache file name keyed by the digest. */
const CACHE_FILE = "sha256-abc123.txt";
const FRAGMENT = "## System tools (CLI)\nsamtools, bcftools\n\n## Node (npm)\nleft-pad\n";
/** The container path of the baked fragment — the last argument of the extraction `run`. */
const FRAGMENT_PATH = "/opt/inflexa/image-packages.txt";

/** Recorded engine calls, as flat argument lists, so a test can assert whether a `run` was ever issued. */
let issued: string[][];

const okResult = (stdout: string): CaptureResult => ({ code: 0, stdout, stderr: "" });
const failResult = (): CaptureResult => ({ code: 1, stdout: "", stderr: "boom" });

/**
 * Stub the engine `capture` seam. `inspect` is the response for the digest read, and `run` is the response
 * for the fragment extraction — each a `CaptureResult` the real seam would return, keyed on the first
 * argument (`image inspect` versus `run`).
 */
function stubCapture(responses: { inspect: CaptureResult; run: CaptureResult }): void {
    issued = [];
    spies.push(
        spyOn(container, "capture").mockImplementation(async (_rt: unknown, args: readonly string[]): Promise<CaptureResult> => {
            issued.push([...args]);
            if (args[0] === "image" && args[1] === "inspect") return responses.inspect;
            if (args[0] === "run") return responses.run;
            return { code: 0, stdout: "", stderr: "" };
        }),
    );
}

const spies: { mockRestore: () => void }[] = [];
let cacheDir: string;

beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "inflexa-image-pkgs-"));
});

afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    rmSync(cacheDir, { recursive: true, force: true });
});

describe("imagePackagesFile — extract and cache the image inventory fragment", () => {
    test("a cache miss extracts the fragment with the entrypoint overridden and writes it to the cache", async () => {
        stubCapture({ inspect: okResult(`${DIGEST}\n`), run: okResult(FRAGMENT) });
        const path = await imagePackagesFile(container.runtimes.docker, IMAGE, cacheDir);

        expect(path).toBe(join(cacheDir, CACHE_FILE));
        expect(readFileSync(join(cacheDir, CACHE_FILE), "utf8")).toBe(FRAGMENT);
        // The miss ran the container with the entrypoint set to `cat` over the baked fragment path.
        expect(issued).toContainEqual(["run", "--rm", "--entrypoint", "cat", IMAGE, FRAGMENT_PATH]);
    });

    test("a cache hit reads the cached file and runs no container", async () => {
        // Seed the cache for this digest, so the hit path returns it without an extraction. The `run`
        // response is a failure, which would surface if the hit path wrongly ran the container.
        writeFileSync(join(cacheDir, CACHE_FILE), FRAGMENT);
        stubCapture({ inspect: okResult(`${DIGEST}\n`), run: failResult() });
        const path = await imagePackagesFile(container.runtimes.docker, IMAGE, cacheDir);

        expect(path).toBe(join(cacheDir, CACHE_FILE));
        // Only the digest read was issued — no `run`.
        expect(issued.some((args) => args[0] === "run")).toBe(false);
    });

    test("an unreadable digest gives null and runs no container", async () => {
        stubCapture({ inspect: failResult(), run: okResult(FRAGMENT) });
        const path = await imagePackagesFile(container.runtimes.docker, IMAGE, cacheDir);

        expect(path).toBeNull();
        expect(issued.some((args) => args[0] === "run")).toBe(false);
    });

    test("a failed extraction gives null and writes nothing", async () => {
        stubCapture({ inspect: okResult(`${DIGEST}\n`), run: failResult() });
        const path = await imagePackagesFile(container.runtimes.docker, IMAGE, cacheDir);

        expect(path).toBeNull();
        expect(existsSync(join(cacheDir, CACHE_FILE))).toBe(false);
    });

    test("a write failure degrades to null rather than throwing", async () => {
        // Point the cache dir at a regular file, so the directory make and the write both fail. The
        // extraction still degrades to null, so a boot never fails on it.
        const fileAsDir = join(cacheDir, "not-a-dir");
        writeFileSync(fileAsDir, "x");
        stubCapture({ inspect: okResult(`${DIGEST}\n`), run: okResult(FRAGMENT) });
        const path = await imagePackagesFile(container.runtimes.docker, IMAGE, fileAsDir);

        expect(path).toBeNull();
    });
});

// --- the pool inventory (task 3.4) -------------------------------------------
//
// Planning selects from the POOL and never from one farm, because composition links any pool package on
// demand. The graph names the pool, thus the graph is the source, and the catalog template gives the true
// section of each name that it already lists.

const NODE = { imports: [], entry_points: [], edges: [] };

/**
 * The version ordering that the emitter publishes beside the nodes.
 *
 * A fixture derives it from its own nodes, thus the two halves of a graph never
 * disagree. The emitter settles the order of two versions of one name, and no
 * fixture here holds two, thus a group of one needs no rule.
 */
function orderingOf(nodes: Record<string, unknown>): Record<"python" | "r", Record<string, string[]>> {
    const ordering: Record<"python" | "r", Record<string, string[]>> = { python: {}, r: {} };
    for (const [storeDir, node] of Object.entries(nodes)) {
        const name = nameOfStoreDir(storeDir);
        if (name === null) continue;
        const track = (node as { track: "python" | "r" }).track;
        (ordering[track][name] ??= []).push(storeDir);
    }
    return ordering;
}

/** A store root with a graph, and with the template inventory when one is asked for. */
function poolStore(nodes: Record<string, unknown>, templateInventory?: string): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-pool-"));
    roots.push(root);
    writeFileSync(join(root, "deps.json"), `${JSON.stringify({ version: 1, nodes, by_name: orderingOf(nodes) })}\n`);
    if (templateInventory !== undefined) {
        mkdirSync(join(root, "farms", "catalog"), { recursive: true });
        writeFileSync(join(root, "farms", "catalog", "packages.txt"), templateInventory);
    }
    return root;
}

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storePackagesFile — the pool inventory of the store", () => {
    test("a package the pool holds and no farm links is listed, because composition can link it", () => {
        const root = poolStore(
            {
                "scanpy-1.9.0-000000000000aaaa": { track: "python", ...NODE },
                "anndata-0.10.0-000000000000bbbb": { track: "python", ...NODE },
            },
            "# Available packages in the sandbox environment.\n\n## Python (pip)\nanndata\n",
        );

        const path = storePackagesFile(root);

        expect(path).toBe(join(root, "packages.txt"));
        expect(readFileSync(path as string, "utf8")).toContain("## Python (pip)\nanndata, scanpy\n");
    });

    test("the template decides the section of each name that it lists, thus an R package keeps its subtree", () => {
        const root = poolStore(
            {
                "seurat-5.0-000000000000aaaa": { track: "r", r_dir: "Seurat", ...NODE },
                "deseq2-1.42-000000000000bbbb": { track: "r", r_dir: "DESeq2", ...NODE },
            },
            "# h\n\n## R (CRAN)\nSeurat\n\n## R (Bioconductor)\nDESeq2\n",
        );

        const body = readFileSync(storePackagesFile(root) as string, "utf8");

        expect(body).toContain("## R (CRAN)\nSeurat\n");
        expect(body).toContain("## R (Bioconductor)\nDESeq2\n");
    });

    test("a store with no template still presents the shape the harness parses", () => {
        const root = poolStore({ "six-1.17.0-000000000000aaaa": { track: "python", ...NODE } });

        const body = readFileSync(storePackagesFile(root) as string, "utf8");

        expect(body.startsWith("# Available packages in the sandbox environment.\n")).toBe(true);
        expect(body).toContain("## Python (pip)\nsix\n");
    });

    test("a name that only the template lists is not reported, because composition cannot link it", () => {
        // The graph decides the set. A farm and a graph that disagree is a store whose farms are ahead of
        // what composition can reach, and an agent told the farm's name would write an import that fails.
        const root = poolStore({ "six-1.17.0-000000000000aaaa": { track: "python", ...NODE } }, "# h\n\n## Python (pip)\nghost, six\n");

        const body = readFileSync(storePackagesFile(root) as string, "utf8");

        expect(body).toContain("## Python (pip)\nsix\n");
        expect(body).not.toContain("ghost");
    });

    test("a store with no graph reads as unusable, thus the sandbox gate refuses", () => {
        const root = mkdtempSync(join(tmpdir(), "inflexa-pool-"));
        roots.push(root);

        expect(storePackagesFile(root)).toBeNull();
        expect(existsSync(join(root, "packages.txt"))).toBe(false);
    });

    test("a graph that names no package reads as unusable too", () => {
        expect(storePackagesFile(poolStore({}))).toBeNull();
    });

    test("a second read derives nothing, and a newer graph derives again", () => {
        const root = poolStore({ "six-1.17.0-000000000000aaaa": { track: "python", ...NODE } });
        const first = storePackagesFile(root) as string;
        const stamp = statSync(first).mtimeMs;

        expect(storePackagesFile(root)).toBe(first);
        expect(statSync(first).mtimeMs).toBe(stamp);

        // A `store add` appends to the graph. The next read sees the newer graph and derives again.
        const grown = { "six-1.17.0-000000000000aaaa": { track: "python", ...NODE }, "attrs-24.2-000000000000cccc": { track: "python", ...NODE } };
        writeFileSync(join(root, "deps.json"), `${JSON.stringify({ version: 1, nodes: grown, by_name: orderingOf(grown) })}\n`);
        utimesSync(join(root, "deps.json"), new Date(), new Date(stamp + 5_000));

        expect(readFileSync(storePackagesFile(root) as string, "utf8")).toContain("attrs, six");
    });
});
