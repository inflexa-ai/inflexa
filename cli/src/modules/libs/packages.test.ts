import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { imagePackagesFile } from "./packages.ts";
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
