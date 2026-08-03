import { createHash } from "node:crypto";

import { authorNamesMatch, normalizeAuthor, normalizeComparable } from "./normalize.js";
import type { CitationCandidateCluster, CitationIdentifiers, CitationInput, CitationRecord, NormalizedCitation } from "./types.js";

export interface CitationMatchConfig {
    readonly minimumScore: number;
    readonly separationMargin: number;
    readonly clusterSimilarity: number;
    readonly relatedVersionSimilarity: number;
}

export const DEFAULT_MATCH_CONFIG: CitationMatchConfig = {
    minimumScore: 0.72,
    separationMargin: 0.08,
    clusterSimilarity: 0.9,
    relatedVersionSimilarity: 0.9,
};

function tokens(value: string): Set<string> {
    return new Set(
        normalizeComparable(value)
            .split(" ")
            .filter((token) => token.length > 1),
    );
}

export function tokenSimilarity(left: string, right: string): number {
    const a = tokens(left);
    const b = tokens(right);
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection += 1;
    const dice = (2 * intersection) / (a.size + b.size);
    const containment = intersection / Math.min(a.size, b.size);
    return Math.max(dice, containment * 0.96);
}

function normalizedAuthors(authors: readonly string[] | undefined): string[] {
    return [...new Set((authors ?? []).map(normalizeAuthor).filter(Boolean))];
}

function authorSimilarity(left: readonly string[] | undefined, right: readonly string[] | undefined): number {
    const a = normalizedAuthors(left);
    const b = normalizedAuthors(right);
    if (a.length === 0 || b.length === 0) return 0;
    const intersection = a.filter((author) => b.some((candidate) => authorNamesMatch(author, candidate))).length;
    return intersection / Math.min(a.length, b.length);
}

function identifierEntries(identifiers: CitationIdentifiers): string[] {
    return Object.entries(identifiers).flatMap(([kind, value]) => (value === undefined ? [] : [`${kind}:${value.toLocaleLowerCase("en-US")}`]));
}

function sharesStrongIdentifier(left: CitationRecord, right: CitationRecord): boolean {
    const rightIds = new Set(identifierEntries(right.identifiers));
    return identifierEntries(left.identifiers).some((identifier) => rightIds.has(identifier));
}

function hasStrongIdentifier(record: CitationRecord): boolean {
    return identifierEntries(record.identifiers).length > 0;
}

function recordSimilarity(left: CitationRecord, right: CitationRecord): number {
    const weighted: Array<readonly [number, number]> = [];
    if (left.title && right.title) weighted.push([tokenSimilarity(left.title, right.title), 0.7]);
    if (left.authors && right.authors) weighted.push([authorSimilarity(left.authors, right.authors), 0.2]);
    if (left.year !== undefined && right.year !== undefined)
        weighted.push([left.year === right.year ? 1 : Math.abs(left.year - right.year) === 1 ? 0.5 : 0, 0.1]);
    const weight = weighted.reduce((sum, [, value]) => sum + value, 0);
    return weight === 0 ? 0 : weighted.reduce((sum, [score, value]) => sum + score * value, 0) / weight;
}

function stableClusterId(records: readonly CitationRecord[]): string {
    const identity = records
        .map((record) => `${record.source}:${record.sourceRecordId}`)
        .sort()
        .join("|");
    return `cit-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

class UnionFind {
    private readonly parent: number[];

    constructor(size: number) {
        this.parent = Array.from({ length: size }, (_, index) => index);
    }

    find(index: number): number {
        const parent = this.parent[index]!;
        if (parent === index) return index;
        const root = this.find(parent);
        this.parent[index] = root;
        return root;
    }

    union(left: number, right: number): void {
        const leftRoot = this.find(left);
        const rightRoot = this.find(right);
        if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
    }
}

function clusterScore(input: CitationInput, normalized: NormalizedCitation, records: readonly CitationRecord[]): number {
    const inputIds = new Set(identifierEntries(normalized.identifiers));
    if (records.some((record) => identifierEntries(record.identifiers).some((identifier) => inputIds.has(identifier)))) return 1;

    let best = 0;
    for (const record of records) {
        const signals: Array<readonly [number, number]> = [];
        if (record.title) signals.push([tokenSimilarity(normalized.supplied.title ?? normalized.query, record.title), 0.65]);
        if (normalized.supplied.authors && record.authors) signals.push([authorSimilarity(normalized.supplied.authors, record.authors), 0.2]);
        if (normalized.supplied.year !== undefined && record.year !== undefined) {
            signals.push([normalized.supplied.year === record.year ? 1 : Math.abs(normalized.supplied.year - record.year) === 1 ? 0.5 : 0, 0.1]);
        }
        if (normalized.supplied.venue && record.venue) signals.push([tokenSimilarity(normalized.supplied.venue, record.venue), 0.05]);
        const weight = signals.reduce((sum, [, value]) => sum + value, 0);
        const score = weight === 0 ? 0 : signals.reduce((sum, [value, signalWeight]) => sum + value * signalWeight, 0) / weight;
        best = Math.max(best, score);
    }
    return best;
}

function containsId(cluster: CitationCandidateCluster, key: keyof CitationIdentifiers): boolean {
    return cluster.records.some((record) => record.identifiers[key] !== undefined);
}

function addRelatedVersions(clusters: CitationCandidateCluster[], config: CitationMatchConfig): void {
    for (let left = 0; left < clusters.length; left += 1) {
        for (let right = left + 1; right < clusters.length; right += 1) {
            const a = clusters[left]!;
            const b = clusters[right]!;
            const similarity = Math.max(...a.records.flatMap((one) => b.records.map((two) => recordSimilarity(one, two))));
            if (similarity < config.relatedVersionSimilarity) continue;
            const aArxiv = containsId(a, "arxiv");
            const bArxiv = containsId(b, "arxiv");
            const aDoi = containsId(a, "doi");
            const bDoi = containsId(b, "doi");
            if (aArxiv && bDoi) {
                a.relations.push({ clusterId: b.id, kind: "published_as" });
                b.relations.push({ clusterId: a.id, kind: "preprint_of" });
            } else if (bArxiv && aDoi) {
                a.relations.push({ clusterId: b.id, kind: "preprint_of" });
                b.relations.push({ clusterId: a.id, kind: "published_as" });
            } else {
                a.relations.push({ clusterId: b.id, kind: "related_version" });
                b.relations.push({ clusterId: a.id, kind: "related_version" });
            }
        }
    }
}

export function clusterCitationRecords(
    input: CitationInput,
    normalized: NormalizedCitation,
    records: readonly CitationRecord[],
    config: CitationMatchConfig = DEFAULT_MATCH_CONFIG,
): CitationCandidateCluster[] {
    const union = new UnionFind(records.length);
    for (let left = 0; left < records.length; left += 1) {
        for (let right = left + 1; right < records.length; right += 1) {
            const a = records[left]!;
            const b = records[right]!;
            if (sharesStrongIdentifier(a, b)) union.union(left, right);
            else if ((!hasStrongIdentifier(a) || !hasStrongIdentifier(b)) && recordSimilarity(a, b) >= config.clusterSimilarity) union.union(left, right);
        }
    }

    const grouped = new Map<number, CitationRecord[]>();
    for (let index = 0; index < records.length; index += 1) {
        const root = union.find(index);
        grouped.set(root, [...(grouped.get(root) ?? []), records[index]!]);
    }
    const clusters = [...grouped.values()].map((members) => ({
        id: stableClusterId(members),
        score: clusterScore(input, normalized, members),
        records: members,
        relations: [],
    }));
    clusters.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    addRelatedVersions(clusters, config);
    return clusters;
}

export function selectCitationCluster(
    clusters: readonly CitationCandidateCluster[],
    config: CitationMatchConfig = DEFAULT_MATCH_CONFIG,
): CitationCandidateCluster | undefined {
    const first = clusters[0];
    if (first === undefined || first.score < config.minimumScore) return undefined;
    const second = clusters[1];
    if (second !== undefined && first.score - second.score < config.separationMargin) return undefined;
    return first;
}
