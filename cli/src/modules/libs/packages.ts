/**
 * The package inventory `list_available_packages` reads, resolved on the host.
 *
 * The inventory has two sources. The store the sandbox mounts gives the first
 * source. The runtime image gives the second source. The rule is that the
 * inventory describes what the sandbox mounts, because an agent that is told a
 * package exists, when the mount does not carry it, writes code that fails at
 * import.
 *
 * The store carries the two farm tracks, which are the Python packages and the R
 * packages. `storePackagesFile` reads that inventory from the active farm.
 *
 * The runtime image bakes a fragment that lists the two image-owned tracks, which
 * are the bioconda command-line tools and the Node packages. The host cannot see
 * that container path. Thus `imagePackagesFile` extracts the fragment one time for
 * each image and caches it on the host.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { capture, type ContainerRuntime } from "../../lib/container.ts";
import { mkdirResult, writeFileResult } from "../../lib/fs.ts";

/**
 * The active farm's package inventory inside the store, or null when it is not readable.
 *
 * The store keeps its active farm behind `current`, a symlink `inflexa store use` swaps; the inventory the
 * sandbox mounts is `current/packages.txt`. This reports only whether that one file is present — the
 * shallow shape the CLI reads to build the inventory. It is NOT the harness's own mount-usability check,
 * which also validates `meta.json` and the symlink target. The harness re-checks at each sandbox create.
 *
 * `existsSync` follows the `current` symlink, so a missing or dangling pointer and an absent inventory
 * file all resolve to null. It never throws, so a broken store surfaces as the reported store failure
 * rather than an exception out of the boot sequence.
 */
export function storePackagesFile(storePath: string): string | null {
    const candidate = join(storePath, "current", "packages.txt");
    return existsSync(candidate) ? candidate : null;
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
