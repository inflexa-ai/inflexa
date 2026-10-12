import { readdirSync, realpathSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";

import { errnoCode, isReadableBy, isWritableBy, readlinkResult, statResult, type ProcessIdentity } from "./fs.ts";

/** What a listed entry is, from the folder read alone. Each type that is not a folder or a link (a FIFO, a socket, a device) is `file`. */
export type FolderEntryType = "file" | "folder" | "symlink";

/** One entry of a folder, from the folder read. It carries no fact that needs a `stat`. */
export type FolderEntry = {
    name: string;
    /** The canonical folder path joined with the name. */
    path: string;
    kind: FolderEntryType;
    /** True when the name starts with `.`. */
    hidden: boolean;
};

/** A folder that was read: its canonical path, its sorted entries, and the count of the read before the hidden filter. */
export type FolderRead = {
    /** The canonical path, with each symbolic link resolved. */
    path: string;
    /** The entries after the hidden filter: each `folder` first, then each other entry, each group in name order. */
    entries: FolderEntry[];
    /** The count of entries that the read gave, before the hidden filter. A caller bounds its work on it. */
    rawCount: number;
};

/**
 * Why a folder could not be read. `absent` is `ENOENT`, `not_folder` is `ENOTDIR`, and `unreadable` is each
 * other failure, for example `EACCES`, `EPERM`, `ELOOP`, or `EIO`. `path` is the path that the caller gave.
 */
export type FolderReadError = { type: "absent" | "not_folder" | "unreadable"; path: string; cause: unknown };

/**
 * The facts of a symbolic link. `broken` is true when the `stat` of the target fails with `ENOENT`, `ENOTDIR`, or
 * `ELOOP`. Each other failure, for example `EACCES`, gives `false`.
 */
export type LinkFacts = {
    /** The text that the link stores, which can be relative. `null` when `readlink` fails. */
    target: string | null;
    broken: boolean;
    /** `null` when the `stat` of the target fails. */
    targetKind: "file" | "folder" | null;
};

/**
 * The facts of one entry from one `stat`. For a link the `stat` follows the link, thus the facts describe the
 * target. Each fact that the platform or a failed `stat` cannot give is `null`.
 */
export type EntryDetails = {
    /** The size in bytes. `null` for a folder, and for a link to a folder. */
    size: number | null;
    modifiedMs: number | null;
    /** The permission bits. `null` without a POSIX identity, where Node makes the bits up. */
    mode: number | null;
    readable: boolean | null;
    writable: boolean | null;
    /** `null` for an entry that is not a link. */
    link: LinkFacts | null;
};

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

const BROKEN_LINK_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

function entryKind(dirent: Dirent): FolderEntryType {
    if (dirent.isDirectory()) return "folder";
    if (dirent.isSymbolicLink()) return "symlink";
    return "file";
}

// The tiebreak is a code-unit compare: the base-sensitivity collator calls `A.txt` and `a.txt` equal, and the
// order must be the same for each request, so that two requests for two pages agree.
function compareEntries(a: FolderEntry, b: FolderEntry): number {
    if (a.kind !== b.kind && (a.kind === "folder" || b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
    const byName = NAME_COLLATOR.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function readError(path: string, cause: unknown): FolderReadError {
    const code = errnoCode(cause);
    return { type: code === "ENOENT" ? "absent" : code === "ENOTDIR" ? "not_folder" : "unreadable", path, cause };
}

/**
 * Read one folder: resolve its canonical path, read its names with one `readdirSync`, drop the hidden entries
 * unless `hidden` is true, and sort. It takes no `stat` of an entry, because the kind comes from the dirent. Thus
 * a link to a folder sorts with the files, and a caller reads `entryDetails` for the entries that it shows.
 */
export function readFolder(path: string, hidden: boolean): Result<FolderRead, FolderReadError> {
    let canonical: string;
    let dirents: Dirent[];
    try {
        canonical = realpathSync(path);
        dirents = readdirSync(canonical, { withFileTypes: true });
    } catch (cause) {
        return err(readError(path, cause));
    }
    const entries: FolderEntry[] = [];
    for (const dirent of dirents) {
        const isHidden = dirent.name.startsWith(".");
        if (isHidden && !hidden) continue;
        entries.push({ name: dirent.name, path: join(canonical, dirent.name), kind: entryKind(dirent), hidden: isHidden });
    }
    entries.sort(compareEntries);
    return ok({ path: canonical, entries, rawCount: dirents.length });
}

/**
 * The facts of one entry: one `stat` that follows links, and one `readlink` for a link. It never fails. A `stat`
 * that fails gives `null` facts, for example when the entry goes away after the folder read, and the entry stays.
 */
export function entryDetails(entry: FolderEntry, identity: ProcessIdentity | null): EntryDetails {
    const isLink = entry.kind === "symlink";
    const target = isLink
        ? readlinkResult(entry.path, "folderListing:entryDetails").match(
              (stored) => stored,
              () => null,
          )
        : null;
    return statResult(entry.path, "folderListing:entryDetails").match(
        (stats): EntryDetails => {
            const isFolder = stats.isDirectory();
            return {
                size: isFolder ? null : stats.size,
                modifiedMs: stats.mtimeMs,
                mode: identity ? stats.mode & 0o7777 : null,
                readable: identity ? isReadableBy(stats, identity) : null,
                writable: identity ? isWritableBy(stats, identity) : null,
                link: isLink ? { target, broken: false, targetKind: isFolder ? "folder" : "file" } : null,
            };
        },
        (failure): EntryDetails => {
            const code = errnoCode(failure.cause);
            return {
                size: null,
                modifiedMs: null,
                mode: null,
                readable: null,
                writable: null,
                link: isLink ? { target, broken: code !== undefined && BROKEN_LINK_CODES.has(code), targetKind: null } : null,
            };
        },
    );
}
