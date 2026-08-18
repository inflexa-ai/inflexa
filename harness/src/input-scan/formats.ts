/**
 * Format detection over a bounded byte prefix.
 *
 * A prefix read compared against a magic-byte table is NOT a decode: no parser
 * runs over the bytes, so this belongs in the harness process. Every actual
 * decoder — zlib, HDF5, PDF — stays in the sandbox (see `enrich.ts`), which is
 * the exposure the sandbox exists to contain.
 *
 * Compression wrappers are reported ALONGSIDE the inner format, never in place of
 * it: `.vcf.gz` is a VCF, and a shape observed on the wrapper would present
 * unrelated data as mechanically alike. The wrapper comes from the bytes; the inner
 * format of a wrapped file comes from its extension chain, which the sandbox
 * header readout then confirms against the decompressed stream.
 *
 * The recognised list is a floor, not a closed set. An unrecognised format reports
 * `unknown` with its extension chain preserved, and still joins a shape — shape
 * observation depends on names and sizes, which are always available.
 */

/** Bytes read per file for detection. Enough for every magic below plus a text sniff line. */
export const MAGIC_PREFIX_BYTES = 512;

/** Compression wrappers, keyed by the extension that names them. */
const WRAPPER_EXTENSIONS = new Set(["gz", "bgz", "bgzf", "zst", "zstd", "bz2", "xz"]);

/**
 * Extension → format. This table IS the platform's format floor (see the
 * input-scan-manifest spec); an extension absent from it detects as `unknown`
 * unless its bytes are recognised.
 */
const EXTENSION_FORMATS: Readonly<Record<string, string>> = {
    // Variants
    vcf: "vcf",
    bcf: "bcf",
    tbi: "tabix-index",
    csi: "csi-index",
    // Alignments
    sam: "sam",
    bam: "bam",
    cram: "cram",
    bai: "bam-index",
    crai: "cram-index",
    // Sequence
    fa: "fasta",
    fasta: "fasta",
    fna: "fasta",
    faa: "fasta",
    fq: "fastq",
    fastq: "fastq",
    // Intervals and annotation
    bed: "bed",
    gff: "gff",
    gff3: "gff3",
    gtf: "gtf",
    wig: "wig",
    bw: "bigwig",
    bigwig: "bigwig",
    bb: "bigbed",
    bigbed: "bigbed",
    chain: "chain",
    // Matrices and containers
    h5: "hdf5",
    hdf5: "hdf5",
    h5ad: "h5ad",
    loom: "loom",
    mtx: "matrix-market",
    zarr: "zarr",
    rds: "rds",
    rdata: "rdata",
    // Tabular
    csv: "csv",
    tsv: "tsv",
    txt: "text",
    tab: "tsv",
    parquet: "parquet",
    xlsx: "excel",
    xls: "excel",
    // Genotype
    bim: "plink-bim",
    fam: "plink-fam",
    pgen: "plink-pgen",
    pvar: "plink-pvar",
    psam: "plink-psam",
    // Chemistry and structure
    sdf: "sdf",
    mol: "mol",
    mol2: "mol2",
    smi: "smiles",
    smiles: "smiles",
    pdb: "pdb",
    cif: "mmcif",
    mmcif: "mmcif",
    // Mass spectrometry
    mzml: "mzml",
    mzxml: "mzxml",
    mzid: "mzidentml",
    mgf: "mgf",
    // Arrays
    idat: "idat",
    cel: "cel",
    // Imaging
    dcm: "dicom",
    nii: "nifti",
    tif: "tiff",
    tiff: "tiff",
    // Documents and config
    pdf: "pdf",
    docx: "docx",
    md: "markdown",
    markdown: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    log: "text",
};

/**
 * `.bed` is PLINK's binary genotype table AND the interval format, and only the
 * bytes tell them apart (PLINK writes a three-byte magic).
 */
const PLINK_BED_MAGIC = Buffer.from([0x6c, 0x1b, 0x01]);

function startsWith(buf: Buffer, magic: Buffer | readonly number[]): boolean {
    const bytes = Buffer.isBuffer(magic) ? magic : Buffer.from(magic);
    return buf.length >= bytes.length && buf.subarray(0, bytes.length).equals(bytes);
}

function startsWithText(buf: Buffer, text: string): boolean {
    return startsWith(buf, Buffer.from(text, "latin1"));
}

/**
 * A gzip member whose FEXTRA carries the `BC` subfield is BGZF — the block-gzip
 * form every indexed bioinformatics file uses. Reported distinctly because it is
 * what makes a random-access decode of one member possible.
 */
function gzipWrapper(buf: Buffer): string {
    if (buf.length < 12) return "gzip";
    const flags = buf[3]!;
    const hasExtra = (flags & 0x04) !== 0;
    if (!hasExtra) return "gzip";
    return buf[12] === 0x42 && buf[13] === 0x43 ? "bgzip" : "gzip";
}

/** The wrapper a prefix's magic bytes name, or `undefined` for uncompressed content. */
function detectWrapper(buf: Buffer): string | undefined {
    if (startsWith(buf, [0x1f, 0x8b])) return gzipWrapper(buf);
    if (startsWith(buf, [0x28, 0xb5, 0x2f, 0xfd])) return "zstd";
    if (startsWithText(buf, "BZh")) return "bzip2";
    if (startsWith(buf, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz";
    return undefined;
}

/** Format identified from binary magic alone, independent of any extension. */
function binaryFormat(buf: Buffer): string | undefined {
    if (startsWith(buf, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])) return "hdf5";
    if (startsWithText(buf, "PAR1")) return "parquet";
    if (startsWithText(buf, "CRAM")) return "cram";
    if (startsWithText(buf, "%PDF-")) return "pdf";
    if (startsWith(buf, [0x26, 0xfc, 0x8f, 0x88])) return "bigwig";
    if (startsWith(buf, [0xeb, 0xf2, 0x89, 0x87])) return "bigbed";
    if (startsWithText(buf, "RDX2") || startsWithText(buf, "RDX3")) return "rds";
    if (startsWithText(buf, "II*\0") || startsWithText(buf, "MM\0*")) return "tiff";
    if (startsWith(buf, PLINK_BED_MAGIC)) return "plink-bed";
    if (buf.length >= 132 && buf.subarray(128, 132).toString("latin1") === "DICM") return "dicom";
    if (startsWithText(buf, "IDAT")) return "idat";
    return undefined;
}

/** Format identified from a text prefix — the header line most text formats declare. */
function textFormat(buf: Buffer): string | undefined {
    const head = buf.toString("utf8", 0, Math.min(buf.length, 256));
    if (head.startsWith("##fileformat=VCF")) return "vcf";
    if (head.startsWith("##gff-version 3")) return "gff3";
    if (head.startsWith("##gff-version")) return "gff";
    if (head.startsWith("@HD\t") || head.startsWith("@SQ\t")) return "sam";
    if (head.startsWith("%%MatrixMarket")) return "matrix-market";
    if (head.startsWith("BEGIN IONS")) return "mgf";
    if (head.startsWith("@<TRIPOS>")) return "mol2";
    if (head.startsWith("chain ")) return "chain";
    if (head.startsWith("HEADER    ") || head.startsWith("ATOM  ")) return "pdb";
    if (head.startsWith("data_")) return "mmcif";
    if (head.startsWith("[CEL]")) return "cel";
    if (head.startsWith("track ") || head.startsWith("fixedStep") || head.startsWith("variableStep")) return "wig";
    if (/^<\?xml/.test(head)) {
        if (head.includes("<indexedmzML") || head.includes("<mzML")) return "mzml";
        if (head.includes("<mzXML")) return "mzxml";
        if (head.includes("MzIdentML")) return "mzidentml";
        return "xml";
    }
    if (head.startsWith(">")) return "fasta";
    if (head.startsWith("@")) return "fastq";
    return undefined;
}

/** The extension chain of a basename, outermost last. `sample.vcf.gz` → `["vcf", "gz"]`. */
export function extensionChain(fileName: string): string[] {
    const dot = fileName.indexOf(".");
    // A leading dot names a hidden file, not an extension.
    if (dot <= 0) return [];
    return fileName
        .slice(dot + 1)
        .split(".")
        .filter((part) => part.length > 0 && part.length <= 12)
        .map((part) => part.toLowerCase());
}

/** The extension chain with any compression wrappers stripped from the tail. */
export function innerExtensions(extensions: readonly string[]): string[] {
    const inner = [...extensions];
    while (inner.length > 0 && WRAPPER_EXTENSIONS.has(inner[inner.length - 1]!)) inner.pop();
    return inner;
}

export interface DetectedFormat {
    readonly format: string;
    readonly wrapper?: string;
}

/**
 * Identify a file's format from a bounded prefix of its bytes, falling back to the
 * extension chain — which is all a wrapped file can offer the host, since reading
 * the inner format's magic would mean decompressing.
 *
 * A path segment ending `.zarr` names a chunked store whose members are individually
 * meaningless, so every file beneath one reports `zarr`.
 */
export function detectFormat(args: { readonly path: string; readonly extensions: readonly string[]; readonly prefix: Buffer | null }): DetectedFormat {
    const { path, extensions, prefix } = args;

    if (path.split("/").some((segment) => segment.toLowerCase().endsWith(".zarr"))) return { format: "zarr" };

    const wrapper = prefix ? detectWrapper(prefix) : undefined;
    const inner = innerExtensions(extensions);
    const innerExt = inner[inner.length - 1];
    const byExtension = innerExt ? EXTENSION_FORMATS[innerExt] : undefined;

    if (wrapper) {
        // The inner bytes are behind a decoder; the extension chain is the only inner
        // evidence available here, and the sandbox header readout confirms it.
        return byExtension ? { format: byExtension, wrapper } : { format: "unknown", wrapper };
    }

    if (prefix && prefix.length > 0) {
        const binary = binaryFormat(prefix);
        // A container's specialisation is an extension fact (`.h5ad` and `.loom` are
        // both HDF5), so a more specific extension reading wins over the container magic.
        if (binary === "hdf5" && byExtension && byExtension !== "hdf5") return { format: byExtension };
        if (binary) return { format: binary };

        const text = textFormat(prefix);
        // `@` opens both FASTQ and SAM headers, and `>` opens FASTA; where the extension
        // is explicit it is the better evidence for WHICH text format this is.
        if (text && byExtension && text !== byExtension) {
            const ambiguous = text === "fastq" || text === "fasta" || text === "xml";
            if (ambiguous) return { format: byExtension };
        }
        if (text) return { format: text };
    }

    return { format: byExtension ?? "unknown" };
}
