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

/**
 * Dataset-wide quality findings, on rows of the era that recorded them. Superseded by
 * `caveats`, which is agent-authored prose and nothing else.
 */
export interface DataProfileQualityAssessment {
    concerns: string[];
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

// ── The resolved profile ───────────────────────────────────────────────────
//
// A GROUP is what the agent declared a set of files to BE; a DIMENSION is a dataset-level
// thing that varies. Both are the agent's judgement. Everything numeric here is the
// resolution's: membership, counts, slot cardinalities, and companion completeness are
// computed from the scan, so no field below was asserted by a model.

/**
 * A varying position in a group's display template, as the scan observed it.
 *
 * `sampleValues` is bounded and the record carries nothing wider: a full value
 * enumeration would put the file set back in the row this record exists to keep out of
 * it. The id is scan-scoped — it names the slot within the scan that produced this
 * profile, and a dimension's slot observation refers to it.
 */
export interface DataProfileGroupSlot {
    id: string;
    location: "directory" | "name";
    index: number;
    tokenClass: string;
    distinctValues: number;
    sampleValues: string[];
    /** The slot this one repeats — one token in both a directory segment and the stem is ONE identity. */
    sameAsSlot?: string;
}

/** A member the agent wrote about individually. Never exhaustive — that is the filesystem's job. */
export interface DataProfileMemberAnnotation {
    path: string;
    note: string;
}

/**
 * Companion coverage across a group, computed per member.
 *
 * A machine finding, deliberately structured rather than folded into `caveats`: an
 * average hides the one member whose index is missing, and that is the member a
 * downstream step fails on.
 */
export interface DataProfileCompanionCompleteness {
    expectedCompanions: string[];
    completeMembers: number;
    incompleteMembers: number;
    incompleteSample: { path: string; missingCompanions: string[] }[];
}

/**
 * One declared group — a claim about MEANING, resolved to a membership.
 *
 * `count` counts logical members (a data file and its companions count once); `fileCount`
 * counts the files behind them, and it is `fileCount` that the partition accounting sums.
 * `displayPattern` is the scanner's own template and is display-only: no agent authored
 * it, and nothing computes membership from it.
 */
export interface DataProfileGroup {
    /** Stable within the profile, derived from the group's name. */
    id: string;
    name: string;
    /** What ONE member represents. The grouping decision, stated apart from the description. */
    memberRepresents: string;
    description: string;
    role: string;
    category: string;
    /** What the group actually is, when `category` is `other`. */
    categoryLabel?: string;
    subtype?: string;
    /** Why the agent overrode a pre-suggestion, or chose an arguable category. */
    categoryReason?: string;
    /** Why this group was split off, or why these sets are one group. */
    reason?: string;
    count: number;
    fileCount: number;
    totalBytes: number;
    /** The scanner template the members instantiate. Display-only. */
    displayPattern: string;
    formats: { format: string; count: number }[];
    slots?: DataProfileGroupSlot[];
    memberAnnotations?: DataProfileMemberAnnotation[];
    completeness?: DataProfileCompanionCompleteness;
    /** True for the swept residue — files no operation claimed. Visible by construction. */
    unclassified?: boolean;
}

/** A measurement that was actually performed. Absent means unchecked, never "no overlap". */
export interface DataProfileChecked {
    matched: number;
    of: number;
}

/**
 * Where a slot observation points, in terms that survive the scan that produced it.
 *
 * A slot id is per-scan ephemera — the same id names a different slot after a re-scan
 * reorders the sets — so the durable binding is the set's template plus the slot's
 * position within it, exactly as the recipe keys a split. A binding that no longer
 * resolves strands the profile rather than rebinding to whatever now sits at that
 * position.
 */
export interface DataProfileSlotBinding {
    template: string;
    slotIndex: number;
}

/**
 * One evidenced sighting of a dimension.
 *
 * A slot observation binds to a scanner slot, and its cardinality and values are computed
 * from the scan rather than asserted; `groupIds` are the groups that carry that slot,
 * derived from the operations. Slot bindings are the only link between a group and a
 * dimension.
 */
export type DataProfileObservation =
    | {
          kind: "slot";
          groupIds: string[];
          /** Scan-scoped, and display-only past the scan that wrote it. `binding` is what replays. */
          slotId: string;
          binding?: DataProfileSlotBinding;
          tokenClass: string;
          cardinality: number;
          sampleValues: string[];
          checked?: DataProfileChecked;
          checkedAgainst?: string;
          /**
           * The slot the SCANNER found this one repeats, with the members whose two tokens
           * disagreed. Its own performed measurement, in members rather than values — and
           * the reason `checked` stays absent for such a pair: affix recovery strips literal
           * text off one side, so an exact value-set intersection over two positions the
           * scan matched one-to-one would report them wholly disjoint.
           */
          sameAsSlot?: string;
          sameAsSlotMismatches?: number;
          note?: string;
      }
    | {
          kind: "column";
          path: string;
          column: string;
          exampleValues: string[];
          distinctValues?: number;
          checked?: DataProfileChecked;
          checkedAgainst?: string;
          note?: string;
      }
    | {
          kind: "document";
          path: string;
          citation: string;
          statesCardinality?: number;
          checked?: DataProfileChecked;
          checkedAgainst?: string;
          note?: string;
      };

/**
 * A dataset-level thing that varies, with the evidence it was seen in.
 *
 * There is no canonical cardinality: observations that disagree both stand, and
 * `reconciliations` carries the delta. A renderer shows the numbers side by side.
 */
export interface DataProfileDimension {
    label: string;
    category: string;
    categoryLabel?: string;
    /** Derived from the category, never agent-authored. */
    scope: "biological" | "technical";
    description?: string;
    observations: DataProfileObservation[];
    reconciliations?: { note: string; delta?: number }[];
    nestsUnder?: { dimension: string; evidence: string };
    /** Why the dataset deviates from the category's default treatment. */
    treatmentReason?: string;
}

/** What the agent found when it looked for one of the standard dimensions. */
export interface DataProfileProbeReport {
    probe: string;
    outcome: "found" | "not-found" | "found-but-constant" | "attested";
    dimension?: string;
    searched?: string[];
    reason?: string;
    value?: string;
    evidence?: string;
    citation?: string;
    path?: string;
}

/** Files the scan removed before structure was observed, with why. */
export interface DataProfileQuarantine {
    count: number;
    totalBytes: number;
    reasons: { reason: string; count: number }[];
    sample: string[];
}

/**
 * The census, derived rather than declared.
 *
 * `keptFiles` equals the sum of every group's `fileCount`, `unclassified` included.
 * Quarantined files are accounted separately, with their reasons. That the numbers sum
 * is what turns "how much did the profile cover" from a question into a fact.
 */
export interface DataProfilePartition {
    scannedFiles: number;
    keptFiles: number;
    keptMembers: number;
    groups: number;
    unclassifiedMembers: number;
    unclassifiedFiles: number;
    quarantine: DataProfileQuarantine;
    /**
     * Members more than one operation claimed after the last repair round. Removed from
     * every claimant and swept into `unclassified`, never awarded by precedence — a
     * machine finding, so it is here rather than in the agent's caveats.
     */
    contested?: { members: number; sample: string[] };
    /** True when the walk stopped at its file ceiling, so the census covers part of the tree. */
    scanTruncated?: boolean;
}

/**
 * One operation, keyed to the scanner TEMPLATES it addressed rather than the menu ids.
 *
 * Menu ids are per-scan ephemera; templates survive a re-scan, so the recipe can be
 * re-resolved against a changed tree.
 *
 * `unclassified` is the one step no agent authored: it records the paths resolution swept
 * because no operation claimed them. It is carried so a replay can tell a file the last
 * profile already declined to classify from a file that is new to the tree — without it
 * an unchanged tree re-absorbs as partial and wakes the agent to re-judge what it already
 * judged.
 */
export interface DataProfileRecipeStep {
    op: "use" | "split" | "merge" | "group" | "unclassified";
    /** The templates this step addressed. Empty for an explicit path grouping. */
    templates: string[];
    /** Position of the split slot within the addressed set's slots. */
    slotIndex?: number;
    /** Slot values each resulting group claimed, for a value-mapped split. */
    valueMapping?: { groupId: string; values: string[] }[];
    paths?: string[];
    /** True when `paths` holds a prefix of the step's membership rather than all of it. */
    pathsTruncated?: boolean;
    groupIds: string[];
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
 * including the planner's, which reads a few hundred characters of it. `groups` holds the
 * dataset's structure, and the members an agent wrote about individually ride on the
 * group they belong to.
 *
 * The writer emits `groups` and `dimensions`; `kinds`, `axes`, `files`, `coverage`, and
 * `qualityAssessment` are what earlier eras wrote and stay readable. There is no version
 * field: optionality is the compatibility mechanism, and a discriminator would be a
 * second mechanism answering the same question.
 */
export interface DataProfileResult {
    summary: string;
    /** The resolved groups the tree partitions into, `unclassified` included. */
    groups?: DataProfileGroup[];
    /** What varies across the dataset, each with its observations. */
    dimensions?: DataProfileDimension[];
    /** One outcome per standard dimension the agent was asked to look for. */
    probes?: DataProfileProbeReport[];
    /** The census. Derived at resolution — kept equals the sum over groups. */
    partition?: DataProfilePartition;
    /** The operations that produced the groups, keyed to scanner templates. */
    recipe?: DataProfileRecipeStep[];
    /** What a planner must know, in the agent's words. Machine findings live in the structured fields. */
    caveats?: string[];
    /** Individually described files — notable singletons on a pre-groups snapshot. */
    files?: DataProfileFile[];
    /** The repeating sets the tree was grouped into, on a snapshot of the kinds era. */
    kinds?: DataProfileKind[];
    /** What varies across those sets, on a snapshot of the same era. */
    axes?: DataProfileAxis[];
    /** The drift comparand. */
    inputSignature?: DataProfileInputSignature;
    /** How much of the scanned tree the kinds describe, on a snapshot of the kinds era. Superseded by `partition`. */
    coverage?: DataProfileCoverage;
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
    /** Dataset-wide findings, on a snapshot of the era that recorded them. Superseded by `caveats`. */
    qualityAssessment?: DataProfileQualityAssessment;
}

/** The profile's lifecycle, as the ledger records it. */
export type DataProfileLifecycleStatus = "pending" | "running" | "completed" | "failed";
