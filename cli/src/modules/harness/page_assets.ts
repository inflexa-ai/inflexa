// The collection of the report page assets, for the build script and for a test of that collection. The
// collection lives in a module of its own, because the build script runs its whole body at import. That
// body awaits a git command, it reads the baked environment variables, and it stops the process when one
// of them is absent. Thus a test cannot import the collection from the build script, and the two callers
// share this module instead.
import { readFileSync } from "node:fs";

import { type Result, err, ok } from "neverthrow";

// The manifest and its lookup come from the modules that hold them, and not from the front door of the
// harness. The front door evaluates the whole runtime graph of the harness, which costs about 800 ms.
// These two modules are constants and one resolution over the node builtins. A build script drives a
// bundler, thus it must not pull a runtime graph into that process for a table of string pairs.
import { resolvePageAssetFromInstallation } from "@inflexa-ai/harness/report-render/asset-lookup.js";
import { PAGE_ASSETS, type PageAsset } from "@inflexa-ai/harness/report-render/assets.js";

import type { PackEntry } from "./content-pack.ts";

/**
 * How the collection finds the source file of one asset.
 *
 * The parameter is the module specifier of the asset, and the return value is the path of its file. The
 * function throws when no resolution answers the specifier, because a module resolution reports that
 * failure as a throw.
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
 * dependencies of the harness, and never of the cli. Thus the default resolution is the lookup of the
 * harness, which reads the installation that holds it, and a caller can give a different resolution and a
 * different manifest.
 *
 * The lookup stays in the harness, because the harness owns the manifest. A package that publishes an
 * `exports` map refuses a subpath that the map does not name, and the browser bundle of a package is such
 * a subpath. A second lookup in the embedder answers the same manifest under a different set of rules,
 * thus a manifest entry can resolve on one side and fail on the other.
 */
export function collectPageAssetEntries(
    resolveSource: ResolveAssetSource = resolvePageAssetFromInstallation,
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
