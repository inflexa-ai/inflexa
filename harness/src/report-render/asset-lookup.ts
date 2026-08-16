/**
 * The lookup of the source file of one staged page asset.
 *
 * A manifest entry (`assets.ts`) names a module specifier, and a caller that stages the assets beside a page
 * needs the file on disk. The resolution reads the installation of the harness, thus the staged bytes are
 * the bytes of the pinned version.
 *
 * The module sits beside the manifest, thus the preview tool and the fixture script read one lookup and
 * neither one carries the module graph of the other.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** The resolver of a package source. It reads the installation that holds this module. */
const moduleResolver = createRequire(import.meta.url);

/**
 * The absolute path of the source file of one manifest specifier.
 *
 * A package that publishes an `exports` map refuses a subpath that the map does not name, and a browser
 * bundle beside the module entry is such a subpath. The fallback then reads the specifier as a path under
 * each candidate `node_modules` directory of the resolution. Thus a bundle that the map hides still stages,
 * and a specifier that names no file still fails with the resolution error of the package.
 */
export function resolvePageAssetFromInstallation(specifier: string): string {
    try {
        return moduleResolver.resolve(specifier);
    } catch (cause) {
        for (const directory of moduleResolver.resolve.paths(specifier) ?? []) {
            const candidate = join(directory, specifier);
            if (existsSync(candidate)) {
                return candidate;
            }
        }
        throw cause;
    }
}
