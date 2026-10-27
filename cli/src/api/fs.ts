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

/** One hit of `GET /api/v1/fs/search`. */
export type FsSearchHit = {
    /** The entry, in the shape and with the enrichment of a list entry. */
    entry: FolderEntryView;
    /** The path of the folder that holds the entry, relative to the canonical scope, with `/` as the separator. Empty for a direct child of the scope. */
    subpath: string;
};

/** The body of `GET /api/v1/fs/search`: the best hits first. */
export type FsSearch = {
    /** At most `limit` hits, in the order of the score, then the shallower entry, then the code-unit name. */
    hits: FsSearchHit[];
    /** True when the walk of the scope had not ended at the time of the score, or when a cap stopped it. */
    truncated: boolean;
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

/** One pin of the file picker. A pin is a fact of the machine, thus it does not depend on an analysis. */
export type PinView = {
    /** The id of the pin. */
    id: string;
    /** The time of the pin, as an ISO 8601 string. */
    createdAt: string;
    /** The time of the last change of the pin, as an ISO 8601 string. */
    updatedAt: string;
    /** The real path that the server stored at the time of the pin. */
    path: string;
    /** The label that the person gave, or `null` when the person gave none. */
    label: string | null;
    /** True when the path was a folder at the time of the pin. */
    isDir: boolean;
    /** The real path of `path` now, or `null` when the server cannot resolve it. A pin with `null` is lost, and it stays in the list. */
    absolutePath: string | null;
};

/** The body of `GET /api/v1/fs/pins`: the pins, oldest first. */
export type PinList = ListEnvelope<"pins", PinView>;

/** The body of `POST /api/v1/fs/pins`. */
export type AddPinRequest = {
    /** An absolute path. The server stores its real path. */
    path: string;
    /** The label of the pin. A blank label is no label. At most 256 characters after the trim. */
    label?: string;
};

/** The body of `DELETE /api/v1/fs/pins/:id`. */
export type DeletePinResponse = {
    deleted: true;
};

/** The body of `POST /api/v1/fs/recents`. */
export type RecordRecentRequest = {
    /** An absolute path. The server stores its real path. */
    path: string;
    /** The analysis of the scope. Without it the scope is the machine. */
    analysisId?: string;
};

/** The body of the response to `POST /api/v1/fs/recents`. */
export type RecordRecentResponse = {
    recorded: true;
};

/** The body of `GET /api/v1/fs/recents`: the recent files of one scope as list entries, newest first. It has no paging fields. */
export type RecentFiles = {
    entries: FolderEntryView[];
};

/** The id of a section of the sidebar of the picker. The response lists the sections in this order. */
export type PlaceSectionId = "analysis" | "favorites" | "locations" | "otherAnalyses" | "drives";

/** The kind of a place that is a folder: the client takes its words and its icon from the kind. */
export type FolderPlaceKind = "workspace" | "run" | "step" | "home" | "desktop" | "documents" | "downloads" | "analysis" | "drive";

/** A place that is one folder. */
export type FolderPlace = {
    kind: FolderPlaceKind;
    /** The data of the place: the name of an analysis, a run id, or the name of a folder. */
    label: string;
    /** The absolute canonical path of the folder. */
    path: string;
};

/** A pin of the machine as a place. */
export type PinPlace = {
    kind: "pin";
    /** The label of the pin, or the name of its path. */
    label: string;
    /** The real path of the pin, or the stored path when `lost` is true. */
    path: string;
    /** The id of the pin, for `DELETE /api/v1/fs/pins/:id`. */
    pinId: string;
    /** True when the server cannot resolve the stored path. */
    lost: boolean;
};

/** The declared inputs of the analysis as one place. It has no path, because the inputs are not in one folder. */
export type InputsPlace = {
    kind: "inputs";
    /** The word `Inputs`. The client takes its own words from `kind`. */
    label: string;
    /** The count of all declared inputs, also the inputs past the cap of `entries`. */
    count: number;
    /** The entry of each of the first declared inputs that the server can locate and that exists, with `isInput` true. */
    entries: FolderEntryView[];
};

/** One item of a section: told by `kind`. */
export type PlaceItem = FolderPlace | PinPlace | InputsPlace;

/** One section of the sidebar. A section with no item stays, with an empty `items`. */
export type PlaceSection = {
    id: PlaceSectionId;
    items: PlaceItem[];
};

/** The body of `GET /api/v1/fs/places`: the sections of the sidebar, in order. */
export type Places = {
    sections: PlaceSection[];
};
