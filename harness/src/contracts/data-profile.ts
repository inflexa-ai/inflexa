/**
 * The data profile's durable-frame identity, on the Cortex wire vocabulary.
 *
 * This lives in `contracts/` — not beside the workflow that stamps it — for the same reason every
 * other name here does: it is a value a CONSUMER reads back, and `contracts/` is the one part of the
 * package a consumer can import without inheriting the harness's own dependencies. The workflow
 * module that uses it pulls in DBOS, the sandbox client, and the profiler agent graph; a host that
 * imported the literal from there would pay ~120ms of module loading to obtain a string, on every
 * command that touches its ledger.
 *
 * That is not a packaging detail to be worked around at the call site. A constant whose whole purpose
 * is to be compared against stored data belongs where the data's vocabulary is declared.
 */

/**
 * The `runId` the harness stamps on every LLM call the data profile makes.
 *
 * A literal, not a minted id: the profile has no run row in any ledger, so this is the only thing
 * identifying its work as the profile's. A consumer needs it to READ BACK what the harness recorded —
 * usage accounting carries one run-id column, so a host reporting consumption "by run" finds profile
 * calls sitting among real runs and can separate them only by comparing against this value.
 *
 * Exported rather than merely documented so that comparison is a compile-time coupling. A host
 * holding its own copy of the string would keep compiling through a rename here, and quietly resume
 * reporting the profile as an unnamed run — a failure with no red test anywhere.
 */
export const DATA_PROFILE_RUN_LITERAL = "data-profile" as const;

// ── The persisted profile ──────────────────────────────────────────────────
//
// The `data_profile_result` JSONB row is the profile's ONLY durable home — the
// profiler's scratch tree is deleted on completion — and it is read by consumers the
// harness does not contain: a host route serving it, a UI rendering it. Those consumers
// need this shape to interpret the row, and must not import the state module to get it
// (that pulls in `pg` and the ledger's whole query surface for a type).
//
// Compatibility here is OPTIONALITY, not versioning. There is no parse at the read
// boundary — the JSONB column is cast straight to `DataProfileResult` — so a snapshot
// written before a field existed simply lacks it, and every consumer must render such a
// row rather than reject it. Adding an optional field is free; making one required is
// not.

/**
 * Where an extracted subject fact came from, so a consumer can judge how much to trust
 * it. Ordered most-direct first in the profiler's own guidance.
 */
export type DataProfileSubjectSource = "metadata" | "document" | "filename" | "user-context" | "inferred";

/** The subject organism, with its provenance and the profiler's confidence in it. */
export interface DataProfileOrganism {
    scientificName: string;
    /** NCBI Taxonomy ID as a string, e.g. `"9606"`. */
    taxonId: string;
    source: DataProfileSubjectSource;
    confidence: "high" | "medium" | "low";
    notes?: string;
}

/**
 * One profiled file's persisted record.
 *
 * `path` + `description` are the original pair every snapshot carries; everything below
 * them is optional on read, because a snapshot written before the record was widened
 * carries only the pair.
 */
export interface DataProfileFile {
    path: string;
    description: string;
    /** Semantic data type (count-matrix, variants, clinical-metadata, document, …). */
    dataType?: string;
    /** File format (CSV, h5ad, VCF, BAM, …). */
    format?: string;
    rows?: number | null;
    cols?: number | null;
    /** Searchable labels the profiler attached. */
    tags?: string[];
    /** Quality issues specific to this file. */
    warnings?: string[];
    /** Flat, identity-establishing facts (sparsity, delimiter, normalizationState, …). */
    metrics?: Record<string, string | number | boolean>;
}

/** Dataset-wide quality findings the profiler recorded. */
export interface DataProfileQualityAssessment {
    concerns: string[];
    strengths: string[];
}

/**
 * One repeating set of files — the dataset's structure, as opposed to its contents.
 *
 * A kind is a claim about MEANING, made by the profiler agent: the deterministic input
 * scan establishes that filenames differ only at one position, and cannot establish that
 * the files are the same sort of thing. A singleton is a kind of `count` 1, so a
 * two-file analysis is two kinds and needs no special case.
 */
export interface DataProfileKind {
    name: string;
    /** What ONE member represents. The grouping decision, stated apart from the description. */
    memberRepresents: string;
    description: string;
    count: number;
    /** Glob the members match, relative to the analysis root. Coverage is computed from it. */
    pathPattern: string;
    format?: string;
    /** Labels of the `axes` that vary across this set's members. */
    axisLabels?: string[];
}

/**
 * What varies across a kind's members — the experimental design, as far as it is
 * observable. The scan reports that a filename position varies and which values it
 * takes; what the variation IS is the agent's label.
 */
export interface DataProfileAxis {
    label: string;
    cardinality: number;
    exampleValues?: string[];
    description?: string;
}

/**
 * The comparand identifying WHICH files a profile covered and whether the SAME BYTES
 * were profiled.
 *
 * `digest` is a stable hash over the staged inputs' identities, sizes, and mtimes in a
 * canonical order, so it depends on the set and not on enumeration order. It excludes
 * content hashes deliberately: enumerating those would mean reading every input in full
 * on every parity check. An edit preserving both byte length and mtime is therefore not
 * detected — bounded, and documented.
 */
export interface DataProfileInputSignature {
    count: number;
    digest: string;
}

/**
 * How much of the scanned tree the profile's kinds describe.
 *
 * Computed deterministically by matching the submitted kind patterns against the scanned
 * file set — never self-reported. Low coverage is a distinct failure from drift: a
 * profile that classified a fraction of its inputs used to carry the same comparand as
 * one that classified all of them, so it read as complete and fresh. Coverage does NOT by
 * itself drive a re-profile, because some input sets legitimately resist classification.
 */
export interface DataProfileCoverage {
    matched: number;
    unmatched: number;
    total: number;
    unmatchedSample?: string[];
}

/**
 * One profiled input file's legacy drift signature. `fileId` is a path identity (two
 * files at the same path share it regardless of content), so `size` + `mtimeMs` are what
 * let a consumer notice the bytes behind a path changed. Superseded by
 * {@link DataProfileInputSignature}, and still readable on older rows.
 */
export interface DataProfileInputFile {
    fileId: string;
    size: number;
    mtimeMs: number;
}

/**
 * The profile snapshot stored in `cortex_analysis_state.data_profile_result`.
 *
 * It carries the profiler's full finding rather than a summary of it: this row is the
 * profile's only durable home, so a field dropped on the way in is not "summarized
 * away", it is destroyed, and the next reader can recover it only by re-reading the raw
 * inputs.
 *
 * It does NOT carry a record per input file. The workspace filesystem is the
 * authoritative file list — listing, grep, and the vector index all read the live tree —
 * so a copy here would be a stale duplicate on a row detoasted by every reader,
 * including the planner's, which reads a few hundred characters of it. `files` holds the
 * individually notable inputs; `kinds` holds the dataset's structure.
 */
export interface DataProfileResult {
    summary: string;
    /** Individually described files — notable singletons, not the dataset's contents. */
    files: DataProfileFile[];
    /** The repeating sets the tree was grouped into. Absent on a pre-kinds snapshot. */
    kinds?: DataProfileKind[];
    /** What varies across those sets. Absent for the same reason as `kinds`. */
    axes?: DataProfileAxis[];
    /** The drift comparand. Preferred over `inputFileIds`, which it replaces. */
    inputSignature?: DataProfileInputSignature;
    /** How much of the scanned tree the kinds describe. Absent on pre-coverage snapshots. */
    coverage?: DataProfileCoverage;
    /** The legacy identity-list comparand, on rows written before the signature existed. */
    inputFileIds?: string[];
    /** The legacy per-file drift signature, on rows of the same era. */
    inputFiles?: DataProfileInputFile[];
    /** ISO 8601 timestamp of profile completion. */
    profiledAt: string;

    /** Scientific domain (transcriptomics, cheminformatics, clinical, …). */
    domain?: string;
    /** Specific subtype within the domain (bulk-rna-seq, single-cell, LC-MS/MS, …). */
    subtype?: string;
    /**
     * Explicit `null` is a real, distinct value — the profiler looked and no input
     * identified an organism — as opposed to absent, which means the snapshot predates
     * the field.
     */
    organism?: DataProfileOrganism | null;
    tissue?: string | null;
    cellType?: string | null;
    condition?: string | null;
    /** Public dataset accessions found in any input (GSE/SRP/PRJNA/E-MTAB/phs/EGAS). */
    accessions?: string[];
    /** Conditions, groups, comparisons, replicates, pairing. */
    experimentalDesign?: string;
    qualityAssessment?: DataProfileQualityAssessment;
}

/** The profile's lifecycle, as the ledger records it. */
export type DataProfileLifecycleStatus = "pending" | "running" | "completed" | "failed";
