/**
 * Detected-set vocabulary.
 *
 * A **set** is a mechanical fact: these paths instantiate one template. A **slot** is
 * a position in that template whose token varies, reported with its class, its
 * distinct-value count, and a bounded sample of the values themselves — a count alone
 * cannot tell an entity identifier from a categorical label from a shard index, and
 * those readings imply entirely different groupings.
 *
 * Nothing here decides a grouping, and nothing here is named `groups` or `dimensions`:
 * that half belongs to the profiler agent, and a result an agent could copy into its
 * submission would make its central judgement invisible (see the input-scan-manifest
 * spec).
 */

import type { FormatCount, UnstructuredEntry } from "./types.js";
import type { SlotTokenClass } from "./tokens.js";

/** Why a file never reached the menu. */
export type QuarantineReason = "os-junk" | "editor-temp" | "partial-download" | "atomic-write-temp";

export interface QuarantineReasonCount {
    readonly reason: QuarantineReason;
    readonly count: number;
}

/**
 * Quarantine is visible, never silent: a wrongly excluded file has to be discoverable
 * by the agent and the user, so the counts and a bounded path sample are reported.
 */
export interface QuarantineSummary {
    readonly count: number;
    readonly totalBytes: number;
    readonly reasons: readonly QuarantineReasonCount[];
    readonly sample: readonly string[];
}

/** A helper file that carries no meaning apart from the data file it serves. */
export interface CompanionFile {
    readonly path: string;
    /** The suffix that identified it — `.tbi`, `.bai`, `.md5`. */
    readonly suffix: string;
    readonly size: number;
}

/**
 * A data file plus its companions — the logical unit the pipeline mines and counts.
 *
 * Membership counts logical units, so a variant file and its index are one member, and
 * "N files, M indexed" becomes a computed completeness rather than a claim.
 */
export interface MemberFile {
    readonly path: string;
    readonly name: string;
    readonly size: number;
    readonly format: string;
    readonly wrapper?: string;
    readonly companions: readonly CompanionFile[];
}

export interface SetMember extends MemberFile {
    /** Companion suffixes the rest of the set carries and this member does not. */
    readonly missingCompanions: readonly string[];
}

export interface IncompleteMember {
    readonly path: string;
    readonly missingCompanions: readonly string[];
}

/**
 * Companion coverage across a set, reported per member rather than averaged: an
 * average hides the one member whose index is missing, which is exactly the fact a
 * downstream step will fail on.
 */
export interface SetCompleteness {
    /** Suffixes enough of the set carries that their absence is a gap, not a variation. */
    readonly expectedCompanions: readonly string[];
    readonly completeMembers: number;
    readonly incompleteMembers: number;
    readonly incompleteSample: readonly IncompleteMember[];
}

export type SlotLocation = "directory" | "name";

/**
 * A varying position in a set's path template.
 *
 * `sampleValues` is bounded and normative — it is the material a grouping decision
 * rests on. The complete value set stays on {@link DetectedSets.slotValues},
 * host-side, for arithmetic a bounded sample cannot do.
 */
export interface SetSlot {
    /** Unique within one scan, so a cross-check can name the slot it links to. */
    readonly id: string;
    readonly location: SlotLocation;
    /** Directory segment index, or token index within the name. */
    readonly index: number;
    readonly tokenClass: SlotTokenClass;
    readonly width?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly skeleton?: string;
    /** Literal text fused to the front of the token, recovered from what every value shares. */
    readonly prefix?: string;
    readonly suffix?: string;
    readonly distinctValues: number;
    readonly sampleValues: readonly string[];
    /** The slot this one repeats. A token in both a directory and the stem is ONE identity, not two. */
    readonly sameAsSlot?: string;
    /** Members whose two positions disagreed, when the link was made despite them. */
    readonly crossCheckMismatches?: number;
}

/** A template rendered as a sequence: concatenating it reproduces {@link DetectedSet.pathTemplate}. */
export type TemplateSegment = { readonly kind: "literal"; readonly text: string } | { readonly kind: "slot"; readonly slotId: string };

/**
 * How a set came to be.
 *
 * A consumer has to be able to tell these apart: a `catch-all` set is evidence that
 * the same directory shape repeats, not that the filenames agree, and reading it as a
 * name-structure fact would overstate what the scan established.
 */
export type SetOrigin = "marker" | "mined" | "prefix" | "family" | "catch-all";

/** Compression wrappers observed across a set's members. `none` names the uncompressed. */
export interface WrapperCount {
    readonly wrapper: string;
    readonly count: number;
}

export interface DetectedSet {
    /** Stable within one scan (`set-1`, `set-2`, …). */
    readonly id: string;
    readonly origin: SetOrigin;
    /** The catalogue entry that claimed this subtree, when `origin` is `marker`. */
    readonly marker?: string;
    readonly pathTemplate: string;
    readonly segments: readonly TemplateSegment[];
    /** Logical units — a data file and its companions count once. */
    readonly memberCount: number;
    /** Files, companions included. */
    readonly fileCount: number;
    readonly totalBytes: number;
    /**
     * Format and wrapper disagreement inside a set is a property OF the set, never a
     * partition key: members that differ only in compression are one set that says so.
     */
    readonly formats: readonly FormatCount[];
    readonly wrappers: readonly WrapperCount[];
    readonly slots: readonly SetSlot[];
    readonly completeness: SetCompleteness;
    readonly examplePaths: readonly string[];
    /** Complete membership. Host-side: the bounded projection is everything above. */
    readonly members: readonly SetMember[];
}

/**
 * Files no set speaks for, in aggregate.
 *
 * Never one set per file: a tree of arbitrarily named files would otherwise produce a
 * set count proportional to the file count. Whether these are notable singletons worth
 * describing or an unclassified remainder is the agent's determination.
 */
export interface LeftoverFiles {
    readonly memberCount: number;
    /** Members plus the companions riding on them, so it adds up against `keptFileCount`. */
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly sample: readonly UnstructuredEntry[];
}

export interface SetRepresentative {
    readonly setId: string;
    readonly path: string;
}

/**
 * Which files a header readout should open.
 *
 * One representative per set plus every leftover: within a set the members are alike
 * by construction, so a readout per file buys nothing and costs the enrichment budget
 * this pipeline exists to bound.
 */
export interface ReadoutSelection {
    readonly representatives: readonly SetRepresentative[];
    /** Leftover paths — the files no set speaks for, each read on its own. */
    readonly individual: readonly string[];
}

export interface DetectedSets {
    readonly fileCount: number;
    /** Files that survived quarantine — the denominator coverage is measured against. */
    readonly keptFileCount: number;
    readonly coverage: number;
    readonly quarantine: QuarantineSummary;
    readonly sets: readonly DetectedSet[];
    readonly leftovers: LeftoverFiles;
    /** Complete leftover membership. Host-side, for the same reason as {@link DetectedSet.members}. */
    readonly leftoverMembers: readonly MemberFile[];
    readonly readout: ReadoutSelection;
    /**
     * Complete value sets, keyed by slot id. Host-side only: completeness arithmetic,
     * cross-set identity checks, and the index build need every value, while anything
     * rendered or persisted carries {@link SetSlot.sampleValues}.
     */
    readonly slotValues: ReadonlyMap<string, readonly string[]>;
    /**
     * Per slot id, the value each member of that slot's set carries, aligned to
     * {@link DetectedSet.members}. Host-side only, and the material a split resolves
     * against: partitioning a set by one of its slots is a lookup here, never a
     * re-tokenisation of the member's name.
     */
    readonly memberSlotValues: ReadonlyMap<string, readonly string[]>;
}
