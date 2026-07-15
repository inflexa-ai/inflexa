// First-run materialization of the binary's embedded skills/templates. A release build ships those
// trees packed inside the executable (see scripts/build.ts + content-pack.ts); on boot this extracts
// them to the hash-keyed dir under env.contentDir that config.ts already resolves skillsDir/templatesDir
// to, so the harness — which reads both as plain directory trees off disk — finds them. See the
// content-assets and harness-runtime specs.
//
// This module is reached ONLY through runtime.ts's release-gated `await import("./content.ts")`. That
// gate, plus the fact that the embedded-archive import below only resolves when the module actually
// loads, is what keeps `cli/content.pack` (which exists solely as a build artifact) out of a dev run's
// module graph — a dev checkout has no such file, and a dev run resolves skills/templates to the repo
// trees instead. Verified empirically: an UNgated top-level asset import would demand the file on disk
// even in dev.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type Result, err, ok } from "neverthrow";

import { env } from "../../lib/env.ts";

import { unpackTo } from "./content-pack.ts";

// Bun's file loader resolves this to a path STRING — a real disk path in dev, a /$bunfs/root/... path in
// a compiled binary — and embeds the bytes into the executable. Reading it (below) is deferred to the
// cold path, so it costs nothing on a warm boot.
import CONTENT_PACK_PATH from "../../../content.pack" with { type: "file" };

/** Why bundled content could not be materialized — each variant maps to one actionable boot message. */
export type ContentError =
    | { type: "no_content_hash" }
    | { type: "archive_read_failed"; cause: unknown }
    | { type: "extract_failed"; detail: string }
    | { type: "unwritable"; path: string; cause: unknown };

/** The two directory paths the harness consumes, once materialized on disk. */
export type ContentDirs = { readonly skillsDir: string; readonly templatesDir: string };

/**
 * Extract the embedded archive to `<contentDir>/<contentHash>/{skills,templates}` and return those dirs.
 *
 * Idempotent and cheap on the warm path: an already-present hash dir is reused with only two `existsSync`
 * checks. A NEW binary version bakes a new content hash, so its first run misses the warm path, extracts a
 * fresh tree, and prunes the stale ones — which is exactly how a version upgrade updates the on-disk
 * skills/templates with no separate step. Release-only: the sole caller (runtime.ts) gates on
 * `env.isDevelopment`, so a dev run never reaches here.
 */
export function ensureBundledContent(): Result<ContentDirs, ContentError> {
    const hash = env.contentHash;
    // A correctly built release binary always bakes INFLEXA_CONTENT_HASH; its absence means a broken
    // build reached a user, so fail loudly rather than extract into `<contentDir>/undefined`.
    if (!hash) return err({ type: "no_content_hash" });

    const target = join(env.contentDir, hash);
    const dirs: ContentDirs = { skillsDir: join(target, "skills"), templatesDir: join(target, "templates") };

    if (existsSync(dirs.skillsDir) && existsSync(dirs.templatesDir)) {
        pruneStale(hash);
        return ok(dirs);
    }

    // Cold path: unpack into a private temp sibling, then atomically `rename` it onto the hash dir. The
    // rename is the commit point — a partially written tree is never visible under `target`, and a
    // concurrent inflexa extracting the same hash simply finds `target` already present.
    let archive: Buffer;
    try {
        archive = readFileSync(CONTENT_PACK_PATH);
    } catch (cause) {
        return err({ type: "archive_read_failed", cause });
    }

    try {
        mkdirSync(env.contentDir, { recursive: true });
    } catch (cause) {
        return err({ type: "unwritable", path: env.contentDir, cause });
    }

    const tmp = join(env.contentDir, `.tmp-${hash}-${process.pid}`);
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
        if (!(existsSync(dirs.skillsDir) && existsSync(dirs.templatesDir))) {
            return err({ type: "unwritable", path: target, cause });
        }
    }

    pruneStale(hash);
    return ok(dirs);
}

/**
 * Remove content directories left by prior binary versions — any sibling of the current hash dir that is
 * neither the current hash nor a live `.tmp-*` staging dir. Best-effort by contract: pruning must NEVER
 * fail a boot, and it deliberately spares temp dirs (another process may be mid-extract).
 */
function pruneStale(currentHash: string): void {
    let names: string[];
    try {
        names = readdirSync(env.contentDir);
    } catch {
        return;
    }
    for (const name of names) {
        if (name === currentHash || name.startsWith(".tmp-")) continue;
        rmQuiet(join(env.contentDir, name));
    }
}

function rmQuiet(path: string): void {
    try {
        rmSync(path, { recursive: true, force: true });
    } catch {
        // best-effort cleanup; never load-bearing
    }
}
