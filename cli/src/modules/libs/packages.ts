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
 * lock of each farm, and the harness tool reads it by path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { capture, type ContainerRuntime } from "../../lib/container.ts";
import { mkdirResult, writeFileResult } from "../../lib/fs.ts";

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
