/**
 * Input scan — the deterministic pass that replaced per-file agent profiling.
 *
 * The scan observes; the profiler agent groups. Nothing exported here names a kind
 * or an axis (see the input-scan-manifest spec).
 */

export { KNOWN_EXTENSIONS, MAGIC_PREFIX_BYTES, detectFormat, extensionChain, innerExtensions, type DetectedFormat } from "./formats.js";
export { detectSets, type DetectSetsOptions } from "./detect-sets.js";
export { type ClusterEvidence, type ContentSimilarity } from "./clustering.js";
export { MAX_SAMPLE_VALUES, MAX_SHAPES, nameStem, observeShapes, tokenizeStem, type ObservedShapes } from "./shapes.js";
export { MAX_SCANNED_FILES, buildManifest, formatBytes, renderInputScanManifest, scanInputTree, type ScanInputTreeArgs } from "./scan.js";
export {
    MAX_CORRESPONDENCES,
    MAX_CORRESPONDENCE_SAMPLE,
    MAX_MENU_SETS,
    buildCorrespondences,
    buildSetMenu,
    renderSetMenu,
    type SetMenu,
    type SlotCorrespondence,
    type UnlistedSets,
} from "./menu.js";
export { readoutTargets, selectReadouts, type ReadoutTarget } from "./readout-budget.js";
export {
    MEMBERS_DECODED_PER_SHAPE,
    SANDBOX_CONTAINER_FORMATS,
    enrichShapes,
    readHeaders,
    type EnrichShapesArgs,
    type ReadHeadersArgs,
    type ReadoutTargetSpec,
} from "./enrich.js";
export { READOUT_PREFIX_BYTES, READOUT_TEXT_BYTES, readPrefix, type PrefixReadout, type ReadoutFields } from "./readout.js";
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
export type {
    CompanionFile,
    DetectedSet,
    DetectedSets,
    IncompleteMember,
    LeftoverFiles,
    MemberFile,
    QuarantineReason,
    QuarantineReasonCount,
    QuarantineSummary,
    ReadoutSelection,
    SetCompleteness,
    SetMember,
    SetOrigin,
    SetRepresentative,
    SetSlot,
    SlotLocation,
    TemplateSegment,
    WrapperCount,
} from "./set-types.js";
export type { SlotTokenClass } from "./tokens.js";
