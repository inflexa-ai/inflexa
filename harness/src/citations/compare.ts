import { authorNamesMatch, normalizeAuthor, normalizeComparable } from "./normalize.js";
import type {
    CitationCandidateCluster,
    CitationConflict,
    CitationField,
    CitationFieldComparison,
    CitationInput,
    CitationRecord,
    CitationSource,
} from "./types.js";

/**
 * Stamped onto every field comparison so a consumer can tell which rules
 * produced it. Bump it when the published comparison semantics change — a
 * revision made before these rules ever shipped is not a new version.
 */
export const CITATION_COMPARISON_RULE_VERSION = "citation-compare-v1";

type Comparable = string | number | string[];

const FIELDS: readonly CitationField[] = ["title", "authors", "year", "venue", "volume", "firstPage"];

function recordValue(record: CitationRecord, field: CitationField): Comparable | undefined {
    return record[field];
}

function normalizedValue(field: CitationField, value: Comparable): string {
    if (field === "authors") return (value as string[]).map(normalizeAuthor).sort().join("|");
    if (field === "year") return String(value);
    return normalizeComparable(String(value));
}

function authorMatch(supplied: readonly string[], source: readonly string[]): boolean {
    return supplied.every((author) => source.some((candidate) => authorNamesMatch(author, candidate)));
}

function fieldMatches(field: CitationField, supplied: Comparable, source: Comparable): boolean {
    if (field === "authors") return authorMatch(supplied as string[], source as string[]);
    if (field === "year") return Math.abs(Number(supplied) - Number(source)) <= 1;
    if (field === "title" || field === "venue") {
        const left = new Set(normalizeComparable(String(supplied)).split(" ").filter(Boolean));
        const right = new Set(normalizeComparable(String(source)).split(" ").filter(Boolean));
        if (left.size === 0 || right.size === 0) return false;
        let shared = 0;
        for (const token of left) if (right.has(token)) shared += 1;
        return (2 * shared) / (left.size + right.size) >= 0.92;
    }
    return normalizedValue(field, supplied) === normalizedValue(field, source);
}

function sourceValues(cluster: CitationCandidateCluster, field: CitationField): Array<{ source: CitationSource; value: Comparable }> {
    return cluster.records.flatMap((record) => {
        const value = recordValue(record, field);
        return value === undefined ? [] : [{ source: record.source, value }];
    });
}

export function compareSuppliedMetadata(input: CitationInput, selected: CitationCandidateCluster | undefined): CitationFieldComparison[] {
    if (selected === undefined) return [];
    return FIELDS.flatMap((field) => {
        const supplied = input[field];
        if (supplied === undefined) return [];
        const values = sourceValues(selected, field);
        const status = values.length === 0 ? "not_compared" : values.every(({ value }) => fieldMatches(field, supplied, value)) ? "match" : "mismatch";
        return [
            {
                field,
                status,
                supplied,
                sourceValues: values,
                ruleVersion: CITATION_COMPARISON_RULE_VERSION,
            },
        ];
    });
}

export function detectCitationConflicts(clusters: readonly CitationCandidateCluster[]): CitationConflict[] {
    return clusters.flatMap((cluster) =>
        FIELDS.flatMap((field) => {
            const values = sourceValues(cluster, field);
            const unique = new Set(values.map(({ value }) => normalizedValue(field, value)));
            return unique.size > 1 ? [{ field, values }] : [];
        }),
    );
}
