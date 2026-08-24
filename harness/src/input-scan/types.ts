/**
 * Input-scan vocabulary.
 *
 * The scan reports what is OBSERVABLE about a staged input tree; it never decides
 * how the tree is grouped (see the input-scan-manifest spec). That separation is
 * carried by the vocabulary itself: a shape is "these filenames differ only here",
 * a kind is "these files are the same sort of thing", and only the profiler agent
 * can establish the second. Nothing here is named `kinds` or `axes`, and no type
 * here is assignable to the profiler's output — a manifest an agent could copy
 * into its submission would make its central judgement invisible.
 */

/** One file the walk found. `path` is relative to the analysis root. */
export interface ScannedFile {
    readonly path: string;
    readonly size: number;
    /** Trailing extension components, outermost last: `sample.vcf.gz` → `["vcf", "gz"]`. */
    readonly extensions: readonly string[];
    /** Format identified from magic bytes, falling back to the extension chain, else `"unknown"`. */
    readonly format: string;
    /** Compression wrapper reported ALONGSIDE the inner format, never in place of it. */
    readonly wrapper?: string;
}

/**
 * A filename position whose token differs across a shape's members.
 *
 * `sampleValues` is normative, not decoration: a count alone cannot distinguish an
 * identifier (`0001`…`800`) from a categorical label (`tumor`/`normal`) from a shard
 * index (`chr1`…`chr22`), and those readings imply entirely different kinds.
 */
export interface VariablePosition {
    /** Token index within the shape's name pattern — the `<n>` placeholder it fills. */
    readonly index: number;
    /** Literal text immediately preceding the token, when any (`PT` in `PT001`). */
    readonly prefix?: string;
    readonly distinctValues: number;
    /** Bounded sample of the values observed at this position. */
    readonly sampleValues: readonly string[];
}

/**
 * How two variable positions vary together. A fully-crossed pair is a nested design
 * (every subject × every timepoint); a partially-crossed one is not, and the
 * difference is design evidence a flat file count destroys.
 */
export interface PositionCooccurrence {
    readonly positions: readonly [number, number];
    /** Distinct value pairs observed. */
    readonly observedPairs: number;
    /** Pairs the two value sets could form. `observedPairs === possiblePairs` is a full crossing. */
    readonly possiblePairs: number;
}

/** Header fields read from a bounded prefix of one member of a shape. */
export interface HeaderReadout {
    /** The member the readout came from. */
    readonly path: string;
    /** Decoder-reported fields, flat and bounded (`delimiter`, `columns`, `sampleCount`, …). */
    readonly fields: Readonly<Record<string, string | number | boolean>>;
    /** Why no readout is present, when the decode did not produce one. */
    readonly unavailable?: string;
}

/**
 * A set of files that are mechanically indistinguishable by name structure, format,
 * and location. A shape is an observation, never a grouping of the dataset: the
 * agent may split one shape into several kinds, cover several shapes with one kind,
 * or ignore the shape entirely.
 */
export interface FileShape {
    /** Stable within one manifest (`shape-1`, `shape-2`, …) so overlaps can name shapes. */
    readonly id: string;
    /** Directory the members share, relative to the analysis root. */
    readonly directory: string;
    /** Name pattern with each variable position rendered as `<n>`. */
    readonly pattern: string;
    readonly format: string;
    readonly wrapper?: string;
    readonly extensions: readonly string[];
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly variablePositions: readonly VariablePosition[];
    readonly cooccurrence: readonly PositionCooccurrence[];
    /** Bounded sample of member paths. */
    readonly examplePaths: readonly string[];
    /** Present once the header readout has run for this shape. */
    readonly header?: HeaderReadout;
}

/**
 * Value-set overlap between two shapes' variable positions, reported WITH its gaps.
 *
 * Correspondence across shapes is heuristic — it depends on stripping shape-specific
 * text before comparing, and near-miss namings defeat it. Reported as evidence it is
 * useful; asserted as a shared axis it is a guess a consumer cannot tell was guessed.
 */
export interface ShapeValueOverlap {
    readonly shapes: readonly [string, string];
    readonly positions: readonly [number, number];
    readonly sharedValues: number;
    /** Values present in the first shape and absent from the second. */
    readonly onlyInFirst: number;
    readonly onlyInSecond: number;
    /** Bounded samples of the two gaps, so a near-complete correspondence names its misses. */
    readonly onlyInFirstSample: readonly string[];
    readonly onlyInSecondSample: readonly string[];
}

/** One member of the no-shared-structure aggregate. */
export interface UnstructuredEntry {
    readonly path: string;
    readonly size: number;
    readonly format: string;
}

/**
 * Files whose name structure matches no other file, in aggregate.
 *
 * Never one shape per file: a tree of arbitrarily named files would otherwise produce
 * a shape count proportional to the file count, which is the unbounded output this
 * capability exists to prevent. Whether these are notable singletons worth prose or
 * an unclassified remainder is the agent's determination.
 */
export interface UnstructuredFiles {
    readonly count: number;
    readonly totalBytes: number;
    /**
     * Bounded sample covering distinct formats first, then the largest files. A
     * size-ordered sample would bury the metadata sheet, the README, and the paper —
     * one file each — under whatever large files failed to group.
     */
    readonly sample: readonly UnstructuredEntry[];
    // Members of shapes past the reported cap land here too; `shapesTruncated` on the
    // manifest says when that happened.
}

/** How many files carry each detected format, across the whole scanned tree. */
export interface FormatCount {
    readonly format: string;
    readonly count: number;
}

/**
 * The agent-facing manifest: bounded by construction, so injecting it into a briefing
 * or returning it from `scan_inputs` costs a fixed amount of context whatever the tree
 * size. The complete per-file list lives on {@link InputScan}, host-side.
 */
export interface InputScanManifest {
    /** Path scanned, relative to the analysis root. */
    readonly root: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    /**
     * True when the walk hit its file ceiling and stopped. The shapes below then
     * describe a prefix of the tree, not all of it — stated rather than silently
     * sampled.
     */
    readonly truncated: boolean;
    /** The ceiling that bound, when `truncated`. */
    readonly scanLimit?: number;
    /** True when the shape list itself was capped; the remainder is folded into `unstructured`. */
    readonly shapesTruncated: boolean;
    readonly formats: readonly FormatCount[];
    readonly shapes: readonly FileShape[];
    readonly valueOverlaps: readonly ShapeValueOverlap[];
    readonly unstructured: UnstructuredFiles;
}

/**
 * The scan's full result. `files` is the complete enumeration — it stays host-side and
 * backs coverage and the index projection; `manifest` is the bounded projection the
 * agent reads.
 */
export interface InputScan {
    readonly files: readonly ScannedFile[];
    readonly manifest: InputScanManifest;
    /**
     * Per shape, the COMPLETE value set of each variable position, keyed by shape id.
     * Bounded output belongs to the manifest; the entity tier of the index needs every
     * value, and re-deriving them from filenames downstream would duplicate the
     * tokenisation.
     */
    readonly positionValues: ReadonlyMap<string, readonly (readonly string[])[]>;
}
