/**
 * Stage 1 — a recognised marker claims its subtree.
 *
 * Some collections announce themselves. Where a marker file names the collection, it
 * identifies it more precisely than its filenames ever could, so the claimed files
 * skip inference entirely: mining a matrix triplet into name templates would report
 * three unrelated singletons where the directory is one thing.
 *
 * The catalogue is a floor, not a closed set.
 */

import type { MemberFile } from "./set-types.js";
import { basenameOf, dirnameOf } from "./tokens.js";

/** A marker whose presence claims the directory it sits in, and nothing below it. */
const DIRECTORY_MARKERS: readonly { readonly label: string; readonly requires: readonly RegExp[] }[] = [
    {
        label: "feature-barcode-matrix",
        requires: [/^matrix\.mtx(\.gz)?$/, /^barcodes\.tsv(\.gz)?$/, /^(features|genes)\.tsv(\.gz)?$/],
    },
];

/**
 * A marker whose presence claims its whole subtree.
 *
 * A descriptor may need corroboration: a bare descriptor file can sit at the root of a
 * tree it does not describe, and letting it claim everything below would swallow the
 * dataset it happens to share a directory with.
 */
const SUBTREE_MARKERS: readonly { readonly label: string; readonly name: string; readonly corroborate?: RegExp }[] = [
    { label: "study-manifest", name: "meta_study.txt" },
    { label: "dataset-descriptor", name: "dataset_description.json", corroborate: /^sub-/ },
];

export interface MarkerUnit {
    readonly label: string;
    readonly root: string;
    readonly members: readonly MemberFile[];
}

function hasCorroboratingChild(files: readonly MemberFile[], root: string, pattern: RegExp): boolean {
    const prefix = root === "" ? "" : `${root}/`;
    return files.some((file) => file.path.startsWith(prefix) && pattern.test(file.path.slice(prefix.length).split("/")[0]!));
}

/** The marker-claimed units of a tree, and the members no marker claimed. */
export function applyMarkers(files: readonly MemberFile[]): { units: MarkerUnit[]; unclaimed: MemberFile[] } {
    const byDirectory = new Map<string, MemberFile[]>();
    for (const file of files) {
        const directory = dirnameOf(file.path);
        const bucket = byDirectory.get(directory);
        if (bucket) bucket.push(file);
        else byDirectory.set(directory, [file]);
    }

    const subtrees: { label: string; root: string }[] = [];
    const directories: { label: string; root: string }[] = [];
    for (const [directory, members] of byDirectory) {
        const names = members.map((member) => basenameOf(member.path));
        for (const marker of DIRECTORY_MARKERS) {
            if (marker.requires.every((pattern) => names.some((name) => pattern.test(name)))) directories.push({ label: marker.label, root: directory });
        }
        for (const marker of SUBTREE_MARKERS) {
            if (!names.includes(marker.name)) continue;
            if (marker.corroborate && !hasCorroboratingChild(files, directory, marker.corroborate)) continue;
            subtrees.push({ label: marker.label, root: directory });
        }
    }

    // An outer claim wins: a study that contains a descriptor is one study, not two units.
    subtrees.sort((a, b) => a.root.length - b.root.length);
    const outermost: { label: string; root: string }[] = [];
    for (const candidate of subtrees) {
        const covered = outermost.some((claim) => candidate.root === claim.root || candidate.root.startsWith(claim.root === "" ? "" : `${claim.root}/`));
        if (!covered) outermost.push(candidate);
    }

    const claimed = new Set<string>();
    const units: MarkerUnit[] = [];
    for (const claim of outermost) {
        const prefix = claim.root === "" ? "" : `${claim.root}/`;
        const members = files.filter((file) => !claimed.has(file.path) && file.path.startsWith(prefix));
        if (members.length === 0) continue;
        for (const member of members) claimed.add(member.path);
        units.push({ label: claim.label, root: claim.root, members });
    }
    for (const claim of directories) {
        const members = (byDirectory.get(claim.root) ?? []).filter((file) => !claimed.has(file.path));
        if (members.length === 0) continue;
        for (const member of members) claimed.add(member.path);
        units.push({ label: claim.label, root: claim.root, members });
    }

    return { units, unclaimed: files.filter((file) => !claimed.has(file.path)) };
}
