import type { ListEnvelope } from "./common.ts";

/** The body of `GET /api/v1/fs/home`. */
export type HomeFolder = {
    /** The home folder of the OS user that runs the server. */
    path: string;
};

/** What an entry is, from the folder read. Each type that is not a folder or a link (a FIFO, a socket, a device) is `file`. */
export type FolderEntryKind = "file" | "folder" | "symlink";

/** The facts of a symbolic link. */
export type FolderEntryLink = {
    /** The text that the link stores, which can be relative. `null` when the server cannot read it. */
    target: string | null;
    /** True when the read of the target fails with `ENOENT`, `ENOTDIR`, or `ELOOP`. Each other failure gives `false`. */
    broken: boolean;
    /** `null` when the server cannot read the target. */
    targetKind: "file" | "folder" | null;
};

/** One entry of a folder. A fact that the server cannot read is `null`, and the entry stays in the list. */
export type FolderEntryView = {
    /** The name of the entry in its folder. */
    name: string;
    /** The canonical folder path joined with the name. */
    path: string;
    /** What the entry is, from the folder read. */
    kind: FolderEntryKind;
    /** `null` for an entry that is not a link. */
    link: FolderEntryLink | null;
    /** The size in bytes. `null` for a folder, and for a link to a folder. For a link it describes the target. */
    size: number | null;
    /** The time of the last change, as an ISO 8601 string. For a link it describes the target. */
    modifiedAt: string | null;
    /** The permission bits. `null` on a platform with no POSIX user ids. For a link it describes the target. */
    mode: number | null;
    /** The verdict of the mode bits and the owner ids for the server user. `null` on a platform with no POSIX user ids. */
    readable: boolean | null;
    /** The verdict of the mode bits and the owner ids for the server user. `null` on a platform with no POSIX user ids. */
    writable: boolean | null;
    /** True when the name starts with `.`. */
    hidden: boolean;
};

/** The facts of the listed folder. */
export type FolderFacts = {
    /** The canonical path, with each symbolic link resolved. */
    path: string;
    /** The verdict of the mode bits and the owner ids for the server user. `null` when the server cannot read the facts of the folder, or has no POSIX user ids. */
    readable: boolean | null;
};

/** The body of `GET /api/v1/fs/list`: each `folder` first, then each other entry, in name order. */
export type FolderList = ListEnvelope<"entries", FolderEntryView> & {
    /** The facts of the listed folder. */
    folder: FolderFacts;
};
