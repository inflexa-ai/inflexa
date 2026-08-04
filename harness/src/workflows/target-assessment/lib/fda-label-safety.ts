/**
 * The typed form of an FDA Structured Product Label's safety prose, and the
 * per-organ projection over it.
 *
 * A label arrives as prose in a handful of named sections. Ingesting it once
 * into this shape is what lets the same warning reach two places without being
 * fetched twice: the synthesis markdown renders the sections, and the dossier's
 * per-organ regulatory signals are segmented out of them. Everything a reader
 * needs to find a signal again — the application number and the label section —
 * rides on the signal, so it satisfies the claim-evidence locator requirement.
 */

import type { OrganSystem } from "../../../contracts/organ-system.js";
import type { EvidenceItem } from "../../../contracts/target-dossier.js";
import { classifyOrgan } from "./meddra-organ-map.js";

/** The label sections whose prose carries a safety finding. */
export const LABEL_SAFETY_SECTIONS = ["boxed_warning", "warnings_and_precautions", "warnings", "contraindications"] as const;
export type LabelSafetySection = (typeof LABEL_SAFETY_SECTIONS)[number];

/** One block of prose, keyed to the label section it was published under. */
export interface LabelSafetyText {
    readonly section: LabelSafetySection;
    readonly text: string;
}

/**
 * One label's identity plus its safety prose.
 *
 * `application_number` is required rather than nullable because it is half of
 * what makes a signal resolvable; a producer holding a label without one has
 * nothing to cite and does not construct this shape.
 */
export interface FdaLabelSafety {
    readonly application_number: string;
    readonly drug_name: string;
    readonly effective_time?: string;
    readonly source_url?: string;
    readonly sections: readonly LabelSafetyText[];
}

/** A warning fragment attributed to one canonical organ, with its locator. */
export interface RegulatoryOrganSignal {
    readonly organ: OrganSystem;
    readonly drug_name: string;
    readonly application_number: string;
    /** The label section the prose was published under. */
    readonly source_section: LabelSafetySection;
    /** What a reader opens to find the excerpt: a numbered marker when the prose carried one. */
    readonly label_section: string;
    readonly excerpt: string;
    readonly evidence: EvidenceItem;
}

export interface OrganSignalProjection {
    readonly signals: readonly RegulatoryOrganSignal[];
    /** Fragments whose organ did not resolve and were therefore not emitted. */
    readonly dropped_count: number;
}

/** What the section reports as having emptied it when nothing resolved. */
export const ORGAN_RESOLUTION_FILTER = "label warning fragments with no resolvable organ";

/**
 * Numbered label-section markers ("5.1 Hepatotoxicity"). Split as a lookahead
 * so the marker stays with the prose it heads. The trailing uppercase-or-paren
 * requirement is what keeps a dose ("2.5 mg") from reading as a marker.
 */
const SECTION_MARKER_SPLIT = /(?=\b\d{1,2}\.\d{1,2}\s+[A-Z(])/;
const SECTION_MARKER_HEAD = /^(\d{1,2}\.\d{1,2})\s+/;

/**
 * Bullet boundaries. Single newlines are NOT boundaries — labels wrap prose
 * mid-sentence, and splitting on the wrap would sever a finding from the organ
 * named in its own heading.
 */
const FRAGMENT_SPLIT = /[•·▪‣]+|\r?\n\s*\r?\n+|\r?\n[ \t]*[-*]\s+/;

/** Below this a fragment is a stray heading remnant, not a finding. */
const MIN_FRAGMENT_CHARS = 16;

/** Excerpt budget per signal — enough to read the finding, bounded for storage. */
const MAX_EXCERPT_CHARS = 400;

interface WarningFragment {
    readonly marker: string | null;
    readonly text: string;
}

function clipExcerpt(text: string): string {
    if (text.length <= MAX_EXCERPT_CHARS) return text;
    return `${text.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`;
}

/**
 * Split one section's prose into the fragments an organ can be attributed to:
 * numbered label-section markers first, then bullets inside each marked block.
 */
export function splitWarningProse(text: string): WarningFragment[] {
    const fragments: WarningFragment[] = [];
    for (const block of text.split(SECTION_MARKER_SPLIT)) {
        const head = SECTION_MARKER_HEAD.exec(block);
        const marker = head?.[1] ?? null;
        const body = head ? block.slice(head[0].length) : block;
        for (const piece of body.split(FRAGMENT_SPLIT)) {
            const collapsed = piece.replace(/\s+/g, " ").trim();
            if (collapsed.length < MIN_FRAGMENT_CHARS) continue;
            fragments.push({ marker, text: collapsed });
        }
    }
    return fragments;
}

/**
 * Resolve a fragment onto the canonical organ vocabulary at its own boundary.
 * The heading — the prose up to its first colon — is tried first, because a
 * label states the organ there and then discusses it; scanning the whole
 * fragment first would let an incidental mention outrank the heading.
 */
function resolveFragmentOrgan(fragment: string): OrganSystem | null {
    const colon = fragment.indexOf(":");
    const heading = colon > 0 ? fragment.slice(0, colon) : "";
    return (heading ? classifyOrgan(heading) : null) ?? classifyOrgan(fragment);
}

function buildEvidence(label: FdaLabelSafety, labelSection: string, excerpt: string, organ: OrganSystem): EvidenceItem {
    return {
        source: "openfda:label",
        predicate: "label_warning",
        excerpt,
        regulatory_reference: {
            document: `FDA prescribing information — ${label.drug_name}`,
            section: labelSection,
            doc_id: label.application_number,
            ...(label.source_url ? { doc_url: label.source_url } : {}),
        },
        metadata: {
            organ,
            drug_name: label.drug_name,
            ...(label.effective_time ? { effective_time: label.effective_time } : {}),
        },
    };
}

/**
 * A short fragment can be a substring of a longer unrelated one, so containment
 * only settles a repeat once the contained text is long enough to be prose
 * rather than a phrase.
 */
const MIN_CONTAINMENT_CHARS = 60;

function isRepeatOf(seen: string, candidate: string): boolean {
    if (seen === candidate) return true;
    if (seen.includes(candidate)) return candidate.length >= MIN_CONTAINMENT_CHARS;
    if (candidate.includes(seen)) return seen.length >= MIN_CONTAINMENT_CHARS;
    return false;
}

/**
 * Order a label's sections for segmentation: published section order, then
 * longest prose first within a section. openFDA returns the highlights summary
 * and the full section under the same key, so reading the longer one first is
 * what makes the shorter repeat recognisable as a repeat rather than the other
 * way round.
 */
function segmentationOrder(sections: readonly LabelSafetyText[]): LabelSafetyText[] {
    const firstSeenAt = new Map<LabelSafetySection, number>();
    for (const [index, s] of sections.entries()) {
        if (!firstSeenAt.has(s.section)) firstSeenAt.set(s.section, index);
    }
    return [...sections].sort((a, b) => firstSeenAt.get(a.section)! - firstSeenAt.get(b.section)! || b.text.length - a.text.length);
}

/**
 * Project a set of ingested labels onto per-organ regulatory signals.
 *
 * A fragment that resolves to no canonical organ is dropped and counted rather
 * than filed under a neighbouring organ. A fragment the highlights section
 * repeats from the full section is emitted once.
 */
export function segmentLabelSafety(labels: readonly FdaLabelSafety[]): OrganSignalProjection {
    const signals: RegulatoryOrganSignal[] = [];
    let droppedCount = 0;

    for (const label of labels) {
        const seenMarkers = new Set<string>();
        const seenText: string[] = [];

        for (const section of segmentationOrder(label.sections)) {
            // A numbered marker settles a repeat only across blocks: one block
            // legitimately carries several fragments under its own `5.1`, while
            // a second block reprising `5.1` is the highlights summary of it.
            const blockMarkers = new Set<string>();

            for (const fragment of splitWarningProse(section.text)) {
                const normalized = fragment.text.toLowerCase();
                const markerKey = fragment.marker ? `${section.section}:${fragment.marker}` : null;
                const repeated = (markerKey !== null && seenMarkers.has(markerKey)) || seenText.some((seen) => isRepeatOf(seen, normalized));
                if (repeated) continue;
                if (markerKey !== null) blockMarkers.add(markerKey);
                seenText.push(normalized);

                const organ = resolveFragmentOrgan(fragment.text);
                if (organ === null) {
                    droppedCount += 1;
                    continue;
                }

                const labelSection = fragment.marker ?? section.section;
                const excerpt = clipExcerpt(fragment.text);
                signals.push({
                    organ,
                    drug_name: label.drug_name,
                    application_number: label.application_number,
                    source_section: section.section,
                    label_section: labelSection,
                    excerpt,
                    evidence: buildEvidence(label, labelSection, excerpt, organ),
                });
            }

            for (const marker of blockMarkers) seenMarkers.add(marker);
        }
    }

    return { signals, dropped_count: droppedCount };
}
