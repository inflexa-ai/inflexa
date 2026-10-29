import type { FileKind } from "../../api/fs.ts";

/** The kind and the highlighter language of a file. A language is a shiki language id, or `text`. */
type FileType = { kind: FileKind; language: string };

/**
 * The only map of the server from a file to its kind and its language: `[kind, language, extensions, names]`. A name
 * matches the whole file name, for a file with no useful extension. Shiki has no grammar for WDL, thus it is `text`.
 * A Snakefile is Python with rules, and a CWL file is YAML. A TIFF file is `data`, not `figure`, because a browser does not show it. `m` is MATLAB and `pl` is Perl, the readings of an analyst.
 */
const FILE_TYPES: readonly (readonly [FileKind, string, readonly string[], (readonly string[])?])[] = [
    ["table", "text", ["txt", "xlsx", "xls", "parquet"]],
    ["table", "csv", ["csv"]],
    ["table", "tsv", ["tsv", "tab"]],
    ["figure", "text", ["png", "jpg", "jpeg", "gif", "webp"]],
    ["figure", "xml", ["svg"]],
    ["code", "python", ["py", "smk"], ["snakefile"]],
    ["code", "r", ["r"]],
    ["code", "json", ["ipynb"]],
    ["code", "bash", ["sh", "bash", "zsh", "sbatch", "slurm"]],
    ["code", "awk", ["awk"]],
    ["code", "perl", ["pl", "pm"]],
    ["code", "julia", ["jl"]],
    ["code", "matlab", ["m"]],
    ["code", "sql", ["sql"]],
    ["code", "nextflow", ["nf"], ["nextflow.config"]],
    ["code", "groovy", ["groovy"]],
    ["code", "text", ["wdl"]],
    ["code", "yaml", ["cwl", "yaml", "yml"]],
    ["code", "stata", ["do"]],
    ["code", "sas", ["sas"]],
    ["code", "jinja", ["j2", "jinja"]],
    ["code", "make", ["mk"], ["makefile"]],
    ["code", "docker", [], ["dockerfile", "containerfile"]],
    ["code", "toml", ["toml"]],
    ["code", "ini", ["ini", "cfg"]],
    ["code", "dotenv", [], [".env"]],
    ["code", "gnuplot", ["gp"]],
    ["code", "c", ["c", "h"]],
    ["code", "cpp", ["cpp", "cc", "hpp"]],
    ["code", "rust", ["rs"]],
    ["code", "go", ["go"]],
    ["code", "java", ["java"]],
    ["code", "fortran-fixed-form", ["f"]],
    ["code", "fortran-free-form", ["f90"]],
    ["code", "diff", ["diff", "patch"]],
    ["log", "log", ["log"]],
    ["data", "json", ["json"]],
    ["data", "jsonl", ["jsonl"]],
    ["data", "xml", ["xml"]],
    [
        "data",
        "text",
        [
            "h5ad",
            "h5",
            "hdf5",
            "loom",
            "rds",
            "rdata",
            "rda",
            "npy",
            "npz",
            "pkl",
            "feather",
            "mtx",
            "bam",
            "sam",
            "cram",
            "bai",
            "vcf",
            "bcf",
            "bed",
            "gff",
            "gff3",
            "gtf",
            "fa",
            "fasta",
            "fna",
            "faa",
            "fastq",
            "fq",
            "bw",
            "bigwig",
            "bedgraph",
            "fai",
            "nwk",
            "newick",
            "sdf",
            "mol2",
            "tif",
            "tiff",
            "zip",
            "tar",
            "bz2",
            "xz",
            "zst",
        ],
    ],
    ["doc", "markdown", ["md", "rmd", "qmd"]],
    ["doc", "html", ["html", "htm"]],
    ["doc", "latex", ["tex"]],
    ["doc", "bibtex", ["bib"]],
    ["doc", "rst", ["rst"]],
    ["doc", "text", ["docx", "pdf"]],
    ["structure", "text", ["pdb", "ent", "cif", "mmcif", "bcif"]],
];

// Two maps, thus a file named `R` or `json` does not match an extension key.
const TYPE_BY_EXTENSION: ReadonlyMap<string, FileType> = new Map(
    FILE_TYPES.flatMap(([kind, language, extensions]) => extensions.map((extension): [string, FileType] => [extension, { kind, language }])),
);
const TYPE_BY_NAME: ReadonlyMap<string, FileType> = new Map(
    FILE_TYPES.flatMap(([kind, language, , names = []]) => names.map((name): [string, FileType] => [name, { kind, language }])),
);

/** The extension of a name in lower case, or `null` for a name with no extension. A leading dot alone is no extension. */
export function extensionOf(name: string): string | null {
    const dot = name.lastIndexOf(".");
    return dot <= 0 || dot === name.length - 1 ? null : name.slice(dot + 1).toLowerCase();
}

/**
 * The kind and the language of a file, or `null` for a name that the map does not know. The argument can be a name or a
 * path: only the part after the last separator counts. A name entry wins over the extension. A `.gz` file takes the kind
 * of the extension before `.gz` when the map knows it, and `data` otherwise, and its language is `text`.
 */
function fileTypeOf(name: string): FileType | null {
    const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
    const byName = TYPE_BY_NAME.get(base.toLowerCase());
    if (byName !== undefined) return byName;
    const extension = extensionOf(base);
    if (extension === null) return null;
    if (extension === "gz") {
        const inner = extensionOf(base.slice(0, -".gz".length));
        return { kind: (inner === null ? undefined : TYPE_BY_EXTENSION.get(inner)?.kind) ?? "data", language: "text" };
    }
    return TYPE_BY_EXTENSION.get(extension) ?? null;
}

/**
 * The kind of a file from the map, or `null` for a name that the map does not know. Refer to {@link fileTypeOf}.
 *
 * The name is the only input. The artifact ledger of the harness classifies a file by its folder
 * (`harness/src/schemas/artifact-manifest.ts`), so the two can disagree for one file, and neither must change to match the other.
 */
export function fileKindOf(name: string): FileKind | null {
    return fileTypeOf(name)?.kind ?? null;
}

/** The highlighter language of a file from the map, or `text` for a name that the map does not know. Refer to {@link fileTypeOf}. */
export function languageOf(name: string): string {
    return fileTypeOf(name)?.language ?? "text";
}
