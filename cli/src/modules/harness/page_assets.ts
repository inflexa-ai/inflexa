// The collection of the report page assets, for the build script and for a test of that collection. The
// collection lives in a module of its own, because the build script runs its whole body at import. That
// body awaits a git command, it reads the baked environment variables, and it stops the process when one
// of them is absent. Thus a test cannot import the collection from the build script, and the two callers
// share this module instead.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type Result, err, ok } from "neverthrow";

// The manifest comes from the module that holds it, and not from the front door of the harness. The front
// door evaluates the whole runtime graph of the harness, which costs about 800 ms. This module is pure
// constants with no import of its own. A build script drives a bundler, thus it must not pull a runtime
// graph into that process for six string pairs.
import { PAGE_ASSETS, type PageAsset } from "@inflexa-ai/harness/report-render/assets.js";

import type { PackEntry } from "./content-pack.ts";

/**
 * How the collection finds the source file of one asset.
 *
 * The parameter is the module specifier of the asset, and the return value is the path of its file. The
 * function throws when no resolution answers the specifier, because that is the contract of
 * `import.meta.resolve`.
 */
export type ResolveAssetSource = (specifier: string) => string;

/** Why the collection of the page assets stopped. Each variant names one cause that an operator can act on. */
export type PageAssetError =
    | { type: "empty_manifest" }
    | { type: "unresolved_specifier"; specifier: string; cause: unknown }
    | { type: "unreadable_source"; specifier: string; path: string; cause: unknown };

/**
 * Collect the page assets of the report as `assets/<file>` archive entries, beside the two content trees.
 *
 * The report page loads its chart runtime and its fonts from a sibling assets directory. One archive
 * carries the three sources, thus one hash covers them together. The packages that hold the bytes are
 * dependencies of the harness, and never of the cli. Thus the default resolution reads the installation of
 * the harness, and a caller can give a different resolution and a different manifest.
 */
export function collectPageAssetEntries(
    resolveSource: ResolveAssetSource = resolveThroughHarness,
    manifest: readonly PageAsset[] = PAGE_ASSETS,
): Result<PackEntry[], PageAssetError> {
    // An empty manifest writes no assets directory. The boot guard reads that directory, thus every boot
    // extracts the archive again, and nothing says why.
    if (manifest.length === 0) return err({ type: "empty_manifest" });

    const entries: PackEntry[] = [];
    for (const asset of manifest) {
        let source: string;
        try {
            source = resolveSource(asset.specifier);
        } catch (cause) {
            return err({ type: "unresolved_specifier", specifier: asset.specifier, cause });
        }
        // A resolver does not always read the disk. Thus a resolved path can name a file that is absent,
        // and that failure is different from a specifier that no resolution answers. One read is both the
        // check of the file and the load of the bytes, thus no window sits between the two.
        try {
            entries.push({ path: `assets/${asset.file}`, bytes: readFileSync(source) });
        } catch (cause) {
            return err({ type: "unreadable_source", specifier: asset.specifier, path: source, cause });
        }
    }
    return ok(entries);
}

/**
 * Resolve one asset specifier through the installation of the harness.
 *
 * Hop one names the installed entry of the harness. Hop two resolves the specifier against that entry.
 * Thus the bytes come from the installation of the harness, and never from the one of the cli.
 * `createRequire` cannot take hop one. The exports map of the harness declares an `import` condition
 * alone, thus a CommonJS resolution of the bare name fails. `import.meta.resolve` gives a `file://` URL,
 * thus `fileURLToPath` converts it into a path.
 */
function resolveThroughHarness(specifier: string): string {
    const harnessEntry = import.meta.resolve("@inflexa-ai/harness");
    return fileURLToPath(import.meta.resolve(specifier, harnessEntry));
}
