// Copy the non-TypeScript runtime assets `tsc` does not emit into dist/.
//
// Each asset keeps its path under src/, so a `new URL(…, import.meta.url)` in the
// module that owns it resolves the same in the source tree and in the published
// package. Listed explicitly rather than globbed: an asset ships because someone
// decided it should, and the test files beside it must not.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = ["input-scan/decoder/container_readout.py"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const asset of ASSETS) {
    const target = join(root, "dist", asset);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, "src", asset), target);
}
