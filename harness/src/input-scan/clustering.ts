/**
 * Stage 2 — sibling directories that agree become one template.
 *
 * A tree whose per-entity variation is expressed as one directory per entity is
 * structure, not the absence of it: grouping within a directory sees one entity at a
 * time and reports thousands of unrelated observations. Sibling directories whose
 * contents agree on name template and format census cluster into instances of one
 * template, and the directory segment becomes a slot like any other.
 *
 * Agreement is judged on three channels, strongest first: the masked name templates
 * beneath each directory, the format census when the directory names are already
 * skeleton-kin, and the immediate subdirectory layout. Content-schema agreement is a
 * fourth channel this pipeline cannot read, so it is injected — see
 * {@link ContentSimilarity}.
 */

import type { MemberFile } from "./set-types.js";
import { DATE_SYMBOL, DIGIT_SYMBOL, ID_SYMBOL, maskSegment, skeletonOf, tokenizeName } from "./tokens.js";
import { COARSE_SIMILARITY, CONTAINMENT_SIMILARITY, FINE_SIMILARITY, MAX_SIGNATURE_KEYS } from "./tuning.js";

export interface DirectoryNode {
    readonly name: string;
    readonly children: Map<string, DirectoryNode>;
    readonly files: MemberFile[];
    readonly fineSignature: Set<string>;
    readonly coarseSignature: Set<string>;
    readonly childNames: Set<string>;
}

/** One concrete directory, carrying the values of the template positions above it. */
export interface DirectoryEntry {
    readonly node: DirectoryNode;
    readonly varValues: readonly string[];
}

/** What a content-schema comparison would be given to judge two candidate clusters by. */
export interface ClusterEvidence {
    readonly names: readonly string[];
    readonly files: readonly MemberFile[];
}

/**
 * Similarity from file contents — header fields, delimiters, column names.
 *
 * The extension point for read-based evidence: this pipeline is pure over paths and
 * sizes, so a host that has header readouts injects the comparison rather than the
 * pipeline reaching for a decoder. Returning `undefined` means "no opinion".
 */
export type ContentSimilarity = (a: ClusterEvidence, b: ClusterEvidence) => number | undefined;

function newNode(name: string): DirectoryNode {
    return { name, children: new Map(), files: [], fineSignature: new Set(), coarseSignature: new Set(), childNames: new Set() };
}

export function buildTree(files: readonly MemberFile[]): DirectoryNode {
    const root = newNode("");
    for (const file of files) {
        const segments = file.path.split("/");
        let node = root;
        for (let i = 0; i < segments.length - 1; i++) {
            const name = segments[i]!;
            let child = node.children.get(name);
            if (!child) {
                child = newNode(name);
                node.children.set(name, child);
            }
            node = child;
        }
        node.files.push(file);
    }
    return root;
}

function coarseKey(suffix: string): string {
    return suffix ? `*.${suffix}` : "*";
}

/**
 * Postorder masked-template signatures: the fine one keys on name skeletons, the
 * coarse one only on extensions. Both are capped — a wide directory needs no more
 * keys than the cap to be compared by.
 */
export function computeSignatures(node: DirectoryNode): DirectoryNode {
    for (const file of node.files) {
        const { tokens, suffix } = tokenizeName(file.name);
        const key = skeletonOf(tokens) + (suffix ? ` ${suffix}` : "");
        if (node.fineSignature.size < MAX_SIGNATURE_KEYS) node.fineSignature.add(key);
        node.coarseSignature.add(coarseKey(suffix));
    }
    for (const child of node.children.values()) {
        computeSignatures(child);
        node.childNames.add(child.name);
        const masked = maskSegment(child.name);
        for (const key of child.fineSignature) if (node.fineSignature.size < MAX_SIGNATURE_KEYS) node.fineSignature.add(`${masked}/${key}`);
        for (const key of child.coarseSignature) node.coarseSignature.add(`${masked}/${key}`);
    }
    return node;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const key of small) if (big.has(key)) intersection++;
    return intersection / (a.size + b.size - intersection);
}

function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    if (small.size === 0) return 0;
    let intersection = 0;
    for (const key of small) if (big.has(key)) intersection++;
    return intersection / small.size;
}

function hasMask(skeleton: string): boolean {
    return skeleton.includes(ID_SYMBOL) || skeleton.includes(DIGIT_SYMBOL) || skeleton.includes(DATE_SYMBOL);
}

/**
 * Two directory names are kin when their masked forms agree, or when they agree up to
 * the first separator and that head carries masked material — `s#` in `s#_intake` and
 * `s#_followup` names the same entity position twice.
 */
function skeletonKin(a: string, b: string): boolean {
    if (a === b && hasMask(a)) return true;
    const head = a.split(/[_\-.]/)[0]!;
    return head === b.split(/[_\-.]/)[0]! && hasMask(head);
}

interface Candidate {
    readonly names: string[];
    readonly entries: DirectoryEntry[];
    skeleton: string;
    readonly fine: Set<string>;
    readonly coarse: Set<string>;
    readonly subdirs: Set<string>;
}

function filesUnder(node: DirectoryNode, out: MemberFile[] = []): MemberFile[] {
    out.push(...node.files);
    for (const child of node.children.values()) filesUnder(child, out);
    return out;
}

function evidenceOf(candidate: Candidate): ClusterEvidence {
    const files: MemberFile[] = [];
    for (const entry of candidate.entries) filesUnder(entry.node, files);
    return { names: candidate.names, files };
}

function agrees(a: Candidate, b: Candidate, contentSimilarity?: ContentSimilarity): boolean {
    if (jaccard(a.fine, b.fine) >= FINE_SIMILARITY) return true;
    if (skeletonKin(a.skeleton, b.skeleton)) {
        if (jaccard(a.coarse, b.coarse) >= COARSE_SIMILARITY) return true;
        if (a.subdirs.size > 0 && b.subdirs.size > 0 && jaccard(a.subdirs, b.subdirs) >= COARSE_SIMILARITY) return true;
    }
    if (a.fine.size >= 2 && b.fine.size >= 2 && containment(a.fine, b.fine) >= CONTAINMENT_SIMILARITY) return true;
    if (contentSimilarity) {
        const score = contentSimilarity(evidenceOf(a), evidenceOf(b));
        if (score !== undefined && score >= FINE_SIMILARITY) return true;
    }
    return false;
}

function absorb(into: Candidate, from: Candidate): void {
    into.names.push(...from.names);
    into.entries.push(...from.entries);
    for (const key of from.fine) if (into.fine.size < MAX_SIGNATURE_KEYS) into.fine.add(key);
    for (const key of from.coarse) into.coarse.add(key);
    for (const key of from.subdirs) into.subdirs.add(key);
}

/**
 * Cluster the child directories of a set of template-equivalent parents.
 *
 * Same-named children are one candidate by construction — they already occupy the same
 * template position. Candidates then merge by agreement, majority first: the largest
 * seeds a cluster, which is the rule that keeps a lone odd directory outside rather
 * than dragging the cluster toward it. A second agglomerative pass merges whole
 * clusters to a fixpoint, because the largest candidate can fail against each sibling
 * individually while the siblings agree with each other.
 */
export function clusterChildren(entries: readonly DirectoryEntry[], contentSimilarity?: ContentSimilarity): { names: string[]; entries: DirectoryEntry[] }[] {
    const byName = new Map<string, Candidate>();
    for (const entry of entries) {
        let candidate = byName.get(entry.node.name);
        if (!candidate) {
            candidate = {
                names: [entry.node.name],
                entries: [],
                skeleton: maskSegment(entry.node.name),
                fine: new Set(),
                coarse: new Set(),
                subdirs: new Set(),
            };
            byName.set(entry.node.name, candidate);
        }
        candidate.entries.push(entry);
        for (const key of entry.node.fineSignature) if (candidate.fine.size < MAX_SIGNATURE_KEYS) candidate.fine.add(key);
        for (const key of entry.node.coarseSignature) candidate.coarse.add(key);
        for (const key of entry.node.childNames) candidate.subdirs.add(key);
    }

    const candidates = [...byName.values()].sort((a, b) => b.entries.length - a.entries.length || b.fine.size - a.fine.size);
    const clusters: Candidate[] = [];
    for (const candidate of candidates) {
        const host = clusters.find((cluster) => agrees(cluster, candidate, contentSimilarity));
        if (host) absorb(host, candidate);
        else
            clusters.push({
                ...candidate,
                names: [...candidate.names],
                entries: [...candidate.entries],
                fine: new Set(candidate.fine),
                coarse: new Set(candidate.coarse),
                subdirs: new Set(candidate.subdirs),
            });
    }

    for (;;) {
        let merged = false;
        for (let i = 0; i < clusters.length && !merged; i++) {
            for (let j = i + 1; j < clusters.length; j++) {
                if (!agrees(clusters[i]!, clusters[j]!, contentSimilarity)) continue;
                absorb(clusters[i]!, clusters[j]!);
                clusters.splice(j, 1);
                merged = true;
                break;
            }
        }
        if (!merged) break;
    }

    return clusters.map((cluster) => ({ names: [...new Set(cluster.names)], entries: cluster.entries }));
}
