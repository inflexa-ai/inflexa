import type { FileKind } from "../../api/fs.ts";

const KIND_EXTENSIONS: readonly (readonly [FileKind, readonly string[]])[] = [
    ["table", ["csv", "tsv", "txt", "xlsx", "parquet"]],
    ["figure", ["png", "svg", "jpg"]],
    ["code", ["py", "r", "ipynb", "toml", "sh"]],
    ["log", ["log"]],
    ["data", ["json", "h5ad", "gz", "bam"]],
    ["doc", ["md", "docx", "pdf"]],
];

const KIND_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map(
    KIND_EXTENSIONS.flatMap(([kind, extensions]) => extensions.map((extension): [string, FileKind] => [extension, kind])),
);

/** The extension of a name in lower case, or `null` for a name with no extension. A leading dot alone is no extension. */
export function extensionOf(name: string): string | null {
    const dot = name.lastIndexOf(".");
    return dot <= 0 || dot === name.length - 1 ? null : name.slice(dot + 1).toLowerCase();
}

/**
 * The kind of a file from the extension of its name, or `null` for no extension and for an extension that the map does not know.
 * The argument can be a name or a path: only the part after the last separator counts. A `.gz` file takes the kind of the
 * extension before `.gz` when the map knows it, and `data` otherwise.
 *
 * The extension is the only input. The artifact ledger of the harness classifies a file by its folder
 * (`harness/src/schemas/artifact-manifest.ts`), so the two can disagree for one file, and neither must change to match the other.
 */
export function fileKindOf(name: string): FileKind | null {
    const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
    const extension = extensionOf(base);
    if (extension === null) return null;
    if (extension === "gz") {
        const inner = extensionOf(base.slice(0, -".gz".length));
        return (inner === null ? undefined : KIND_BY_EXTENSION.get(inner)) ?? "data";
    }
    return KIND_BY_EXTENSION.get(extension) ?? null;
}
