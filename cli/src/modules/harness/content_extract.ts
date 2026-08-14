// This module holds the extract of the bundled content, apart from the module that calls it. The caller
// binds an asset that only a release build makes. A checkout does not carry that file, thus a test process
// cannot load the caller. The path of the archive, the content directory, and the content hash arrive here
// as parameters. Thus a test drives the extract over a temporary directory and over an archive that the
// test builds.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type Result, err, ok } from "neverthrow";

import { unpackTo } from "./content-pack.ts";

/** Why bundled content could not be materialized — each variant maps to one actionable boot message. */
export type ContentError =
    | { type: "no_content_hash" }
    | { type: "archive_read_failed"; cause: unknown }
    | { type: "extract_failed"; detail: string }
    | { type: "unwritable"; path: string; cause: unknown };

/**
 * The three directory paths of the materialized content.
 *
 * The harness reads the skills tree and the templates tree from disk. The embedder binds the page-asset
 * lookup over the assets directory, thus no other code derives that path.
 */
export type ContentDirs = { readonly skillsDir: string; readonly templatesDir: string; readonly assetsDir: string };

/**
 * The three values that {@link extractContent} operates over.
 *
 * The host binds each one at its composition root. Thus this module reads no environment variable and no
 * embedded asset, and a test can vary each value.
 */
export type ContentExtractInput = {
    /** The path of the packed archive that carries the skills tree, the templates tree, and the assets. */
    readonly archivePath: string;
    /** The parent of each hash directory. The extract makes it when it is absent. */
    readonly contentDir: string;
    /** The identity of the file set. It names the hash directory. An absent value is a broken build. */
    readonly contentHash: string | undefined;
};

/**
 * Extract the archive to `<contentDir>/<contentHash>/{skills,templates,assets}` and return those dirs.
 *
 * The extract is idempotent, and the warm path is cheap. It reuses a hash dir that is already present, with
 * one `existsSync` call for each directory. A NEW binary version bakes a new content hash, so its first run
 * misses the warm path, extracts a fresh tree, and prunes the stale ones — which is exactly how a version
 * upgrade updates the on-disk content with no separate step.
 */
export function extractContent(input: ContentExtractInput): Result<ContentDirs, ContentError> {
    const hash = input.contentHash;
    // A correctly built release binary always bakes INFLEXA_CONTENT_HASH; its absence means a broken
    // build reached a user, so fail loudly rather than extract into `<contentDir>/undefined`.
    if (!hash) return err({ type: "no_content_hash" });

    const target = join(input.contentDir, hash);
    const dirs: ContentDirs = {
        skillsDir: join(target, "skills"),
        templatesDir: join(target, "templates"),
        assetsDir: join(target, "assets"),
    };

    if (isComplete(dirs)) {
        pruneStale(input.contentDir, hash);
        return ok(dirs);
    }

    // Cold path: unpack into a private temp sibling, then atomically `rename` it onto the hash dir. The
    // rename is the commit point — a partially written tree is never visible under `target`, and a
    // concurrent inflexa extracting the same hash simply finds `target` already present.
    let archive: Buffer;
    try {
        archive = readFileSync(input.archivePath);
    } catch (cause) {
        return err({ type: "archive_read_failed", cause });
    }

    try {
        mkdirSync(input.contentDir, { recursive: true });
    } catch (cause) {
        return err({ type: "unwritable", path: input.contentDir, cause });
    }

    const tmp = join(input.contentDir, `.tmp-${hash}-${process.pid}`);
    rmQuiet(tmp); // clear any leftover from a crashed prior run under this pid

    const unpacked = unpackTo(archive, tmp);
    if (unpacked.isErr()) {
        rmQuiet(tmp);
        return err({ type: "extract_failed", detail: unpacked.error.type });
    }

    try {
        renameSync(tmp, target);
    } catch (cause) {
        // Lost the extraction race, or a rename-onto-existing rejection (Windows): if the target is now
        // present and complete, treat it as success; otherwise the failure is real.
        rmQuiet(tmp);
        if (!isComplete(dirs)) {
            return err({ type: "unwritable", path: target, cause });
        }
    }

    pruneStale(input.contentDir, hash);
    return ok(dirs);
}

/**
 * Is each directory of the materialized content present on disk?
 *
 * One archive carries the three trees, thus a hash dir that holds a subset comes from a partial extract or
 * from a deletion by hand. Such a dir is not reusable: the warm path must extract again, and the recovery
 * after a lost rename race must report the failure.
 */
function isComplete(dirs: ContentDirs): boolean {
    return existsSync(dirs.skillsDir) && existsSync(dirs.templatesDir) && existsSync(dirs.assetsDir);
}

/**
 * Remove content directories left by prior binary versions — any sibling of the current hash dir that is
 * neither the current hash nor a live `.tmp-*` staging dir. Best-effort by contract: pruning must NEVER
 * fail a boot, and it deliberately spares temp dirs (another process may be mid-extract).
 */
function pruneStale(contentDir: string, currentHash: string): void {
    let names: string[];
    try {
        names = readdirSync(contentDir);
    } catch {
        return;
    }
    for (const name of names) {
        if (name === currentHash || name.startsWith(".tmp-")) continue;
        rmQuiet(join(contentDir, name));
    }
}

function rmQuiet(path: string): void {
    try {
        rmSync(path, { recursive: true, force: true });
    } catch {
        // best-effort cleanup; never load-bearing
    }
}
