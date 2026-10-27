/** A folder or file that the person pinned in the file picker. A pin is a fact of the machine, thus it has no analysis. */
export type PickerPin = {
    /** Primary key. */
    id: string;
    createdAt: number;
    updatedAt: number;

    /** The real path at the time of the pin. The folder can move later, and then the pin is lost. */
    path: string;
    /** The label that the person gave, or `null` when the person gave none. */
    label: string | null;
    isDir: boolean;
};

/** A file or folder that the person opened or previewed in the file picker, in one scope. */
export type RecentFile = {
    /** Primary key. */
    id: string;
    createdAt: number;
    updatedAt: number;

    /** The real path at the time of the post. */
    path: string;
    isDir: boolean;

    /** The analysis of the scope, or `null` for the machine scope. */
    analysisId: string | null;
};
