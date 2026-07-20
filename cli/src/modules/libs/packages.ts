/**
 * The sandbox image's package inventory, cached on the host.
 *
 * `list_available_packages` reads `packages.txt` from the HOST filesystem. That works
 * when the host mounts the library store at the sandbox's own path — a managed
 * deployment does. The cli does not: the store is baked into the pulled image and no
 * `/mnt/libs` bind mount is ever created (see modules/libs/images.ts), so the file
 * exists only inside the image and a host-side read finds nothing. Agents were then
 * told the inventory was unknown on every call.
 *
 * The image build stamps its own load-tested inventory onto the image as an OCI label
 * (scripts/lib-store-label-packages.sh). Reading it is `docker image inspect` — pure
 * metadata on an already-pulled image, so no container is created and no registry
 * client is needed. It is per-arch for free: the pulled image IS the host's arch, so
 * its label is the right list by construction (amd64 carries packages arm64 has no
 * build for, and R may be absent from arm64 entirely).
 *
 * The cache is keyed by image ID, so a refreshed `:latest` that resolves to a new
 * digest lands in a new directory and a stale inventory is never served.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { capture, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";

/** The label the library-store build stamps the inventory into. */
const PACKAGES_LABEL = "ai.inflexa.lib-store.packages";

/** Why an inventory could not be resolved. Every case is non-fatal — the tool degrades to "unknown". */
export type PackageInventoryError =
    | { readonly type: "image_absent"; readonly image: string }
    | { readonly type: "label_missing"; readonly image: string }
    | { readonly type: "cache_write_failed"; readonly path: string; readonly cause: unknown };

/**
 * Host path the inventory for `imageId` is cached at. Keyed by image ID rather than
 * tag: `:latest` moves, and serving the previous image's package list would be worse
 * than serving none, since the agent has no way to tell it is stale.
 */
export function packagesCachePath(imageId: string): string {
    // Image IDs arrive as `sha256:<hex>`; the algorithm prefix is not a path segment.
    const key = imageId.replace(/^sha256:/, "").replace(/[^a-f0-9]/gi, "");
    return join(env.libsDir, key, "packages.txt");
}

/**
 * Read the inventory label out of an already-pulled image and cache it, returning the
 * cached path. Re-reads the label on every call — it is a local metadata lookup, and
 * the write is idempotent, so this costs nothing over checking the cache first while
 * staying correct when the cache directory is wiped.
 */
export async function cachePackageInventory(rt: ContainerRuntime, image: string): Promise<Result<string, PackageInventoryError>> {
    const idProbe = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]);
    if (idProbe.code !== 0) return err({ type: "image_absent", image });
    const imageId = idProbe.stdout.trim();

    // `index` (not `.Config.Labels.<key>`) because the key contains dots, which Go
    // templates would otherwise parse as field traversal.
    const labelProbe = await capture(rt, ["image", "inspect", "--format", `{{index .Config.Labels "${PACKAGES_LABEL}"}}`, image]);
    const inventory = labelProbe.code === 0 ? labelProbe.stdout : "";
    // A missing label prints the Go zero value rather than failing the command.
    if (inventory.trim() === "" || inventory.trim() === "<no value>") return err({ type: "label_missing", image });

    const path = packagesCachePath(imageId);
    try {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, inventory, "utf-8");
    } catch (cause) {
        return err({ type: "cache_write_failed", path, cause });
    }
    return ok(path);
}

/**
 * The cached inventory path for the configured image, or null when there is none.
 *
 * Null is a normal state — no image pulled yet, an image built before the label
 * existed, an unreadable cache dir — and the harness tool reports the package set as
 * unknown rather than guessing. Never throws: a broken inventory must not stop a run.
 */
export async function resolvePackagesFile(rt: ContainerRuntime, image: string): Promise<string | null> {
    const cached = await cachePackageInventory(rt, image);
    return cached.isOk() ? cached.value : null;
}
