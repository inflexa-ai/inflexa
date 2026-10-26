import type { ListEnvelope } from "./common.ts";

/** The body of `GET /api/v1/fs/home`. */
export type HomeFolder = {
    /** The home folder of the OS user that runs the server. */
    path: string;
};

/** What an entry is, from the folder read. Each type that is not a folder or a link (a FIFO, a socket, a device) is `file`. */
export type FolderEntryType = "file" | "folder" | "symlink";

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
    type: FolderEntryType;
    /** The kind of the file from the kind map. `null` for a folder, for a link to a folder, and for a name that the map does not know. */
    kind: FileKind | null;
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
    /**
     * The count of the names in the folder, for a folder and for a link to a folder. It obeys the `hidden` value of the request.
     * `null` for each other entry, and for a folder that the server cannot read.
     */
    itemCount: number | null;
    /** True when the entry is a declared input of the analysis of `analysisId`, or is inside a declared input folder. Always false without `analysisId`. */
    isInput: boolean;
    /** The step that wrote the file, from the artifact ledger. `null` when the ledger has no run and step for the path, and without `analysisId`. */
    origin: FileOrigin | null;
};

/** The run and the step that wrote a file. */
export type FileOrigin = {
    runId: string;
    stepId: string;
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

/** Each kind of a file, in the order of the kind map. The count list of a folder preview follows this order. */
export const FILE_KINDS = ["table", "figure", "code", "log", "data", "doc"] as const;

/** The kind of a file, from the extension of its name. A client shows it as a badge and keeps no map of its own. */
export type FileKind = (typeof FILE_KINDS)[number];

/** The preview of a delimited text file: the head of the file and the shape of its header. */
export type TablePreview = {
    kind: "table";
    /** The text of the head. */
    text: string;
    /** A tab when the header line holds one, and a comma otherwise. */
    separator: "\t" | ",";
    /** The count of the fields of the header line. A separator inside double quotes does not split a field. */
    columnCount: number;
    /** The count of the records after the header, or `null` when the head does not hold the full file. */
    rowCount: number | null;
};

/** The preview of a text file: the head of the file. */
export type TextPreview = {
    kind: "text";
    /** The id of the highlighter language, from the extension of the name. `text` for an extension that the server does not map. */
    language: string;
    /** The text of the head. */
    code: string;
};

/** The preview of an image file. The server reads no byte of it. */
export type FigurePreview = {
    kind: "figure";
    /** The read URL of the real path, relative to the origin of the server. */
    src: string;
    /** The name of the file. */
    alt: string;
};

/** The preview of a folder: one level of it. */
export type FolderPreview = {
    kind: "folder";
    /** The count of the entries that are not hidden. */
    items: number;
    /** The count of the entries for each kind with a count above 0: `folder` first, then the order of {@link FILE_KINDS}. */
    kinds: { kind: FileKind | "folder"; count: number }[];
    /** The first entries in the order of the folder list. */
    names: { name: string; dir: boolean; kind: FileKind | null }[];
};

/** The preview of a file that has no text form, for example a binary file. */
export type CardPreview = {
    kind: "card";
    /** The extension of the name in lower case, or `null` for a name with no extension. */
    format: string | null;
};

/** The body of `GET /api/v1/fs/preview`: one member, told by `kind`. */
export type FilePreview = TablePreview | TextPreview | FigurePreview | FolderPreview | CardPreview;
