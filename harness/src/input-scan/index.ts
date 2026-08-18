/**
 * Input scan — the deterministic pass that replaced per-file agent profiling.
 *
 * The scan observes; the profiler agent groups. Nothing exported here names a kind
 * or an axis (see the input-scan-manifest spec).
 */

export { MAGIC_PREFIX_BYTES, detectFormat, extensionChain, innerExtensions, type DetectedFormat } from "./formats.js";
export { MAX_SAMPLE_VALUES, MAX_SHAPES, nameStem, observeShapes, tokenizeStem, type ObservedShapes } from "./shapes.js";
export { MAX_SCANNED_FILES, buildManifest, renderInputScanManifest, scanInputTree, type ScanInputTreeArgs } from "./scan.js";
export { MEMBERS_DECODED_PER_SHAPE, enrichShapes, type EnrichShapesArgs } from "./enrich.js";
export { computeCoverage, type ProfileCoverage } from "./coverage.js";
export type {
    FileShape,
    FormatCount,
    HeaderReadout,
    InputScan,
    InputScanManifest,
    PositionCooccurrence,
    ScannedFile,
    ShapeValueOverlap,
    UnstructuredEntry,
    UnstructuredFiles,
    VariablePosition,
} from "./types.js";
