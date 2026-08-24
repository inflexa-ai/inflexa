/**
 * Companion attachment — an index, a checksum, or a dictionary is not data.
 *
 * A companion carries no meaning apart from the file it serves, so it is not a member
 * and it is not a set: it attaches, and the member becomes the logical unit of a data
 * file plus its helpers. That is what turns "N variant files, M of them indexed" from
 * a claim into an arithmetic fact, and it keeps a directory of indexes from mining
 * into a second set that mirrors the first.
 */

import type { CompanionFile, MemberFile, SetCompleteness, SetMember } from "./set-types.js";
import type { ScannedFile } from "./types.js";
import { basenameOf } from "./tokens.js";
import { EXPECTED_COMPANION_SHARE, MAX_INCOMPLETE_SAMPLE } from "./tuning.js";

/** Suffixes that name a helper file. The list is a floor; growth is additive. */
const COMPANION_SUFFIXES: readonly string[] = [".bai", ".crai", ".tbi", ".csi", ".idx", ".fai", ".gzi", ".dict", ".md5", ".sha1", ".sha256"];

/**
 * Companions whose data file conventionally replaces the extension rather than
 * extending it: `sample.bai` serves `sample.bam`, where `sample.bam.bai` serves the
 * same file by extension.
 */
const REPLACED_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
    ".bai": ["bam"],
    ".crai": ["cram"],
    ".fai": ["fa", "fasta", "fna"],
};

function companionSuffixOf(path: string): string | undefined {
    const name = basenameOf(path).toLowerCase();
    for (const suffix of COMPANION_SUFFIXES) {
        // A file that is nothing but the suffix is a name, not a companion.
        if (name.length > suffix.length && name.endsWith(suffix)) return suffix;
    }
    return undefined;
}

function attachmentTarget(path: string, suffix: string, present: ReadonlySet<string>): string | undefined {
    const stripped = path.slice(0, path.length - suffix.length);
    if (present.has(stripped)) return stripped;
    for (const extension of REPLACED_EXTENSIONS[suffix] ?? []) {
        const candidate = `${stripped}.${extension}`;
        if (present.has(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Fold companion files into the data files they serve.
 *
 * A companion whose data file is absent stays a member of its own: the attachment is
 * evidence, and without the data file there is nothing to attach to.
 */
export function attachCompanions(files: readonly ScannedFile[]): MemberFile[] {
    const present = new Set(files.map((file) => file.path));
    const suffixes = new Map<string, string>();
    const targets = new Map<string, string>();
    for (const file of files) {
        const suffix = companionSuffixOf(file.path);
        if (!suffix) continue;
        const target = attachmentTarget(file.path, suffix, present);
        if (target === undefined || target === file.path) continue;
        suffixes.set(file.path, suffix);
        targets.set(file.path, target);
    }

    // `data.csv.md5` may itself be indexed; follow the chain to the file that is data.
    const roots = new Map<string, string>();
    for (const path of targets.keys()) {
        let current = path;
        for (let hops = 0; hops < targets.size + 1; hops++) {
            const next = targets.get(current);
            if (next === undefined) break;
            current = next;
        }
        if (current !== path) roots.set(path, current);
    }

    const attached = new Map<string, CompanionFile[]>();
    for (const file of files) {
        const root = roots.get(file.path);
        if (root === undefined) continue;
        const bucket = attached.get(root);
        const companion: CompanionFile = { path: file.path, suffix: suffixes.get(file.path)!, size: file.size };
        if (bucket) bucket.push(companion);
        else attached.set(root, [companion]);
    }

    const members: MemberFile[] = [];
    for (const file of files) {
        if (roots.has(file.path)) continue;
        const companions = (attached.get(file.path) ?? []).sort((a, b) => a.path.localeCompare(b.path, "en"));
        members.push({
            path: file.path,
            name: basenameOf(file.path),
            size: file.size,
            format: file.format,
            ...(file.wrapper ? { wrapper: file.wrapper } : {}),
            companions,
        });
    }
    return members;
}

/**
 * Per-member companion coverage.
 *
 * A suffix most of the set carries is expected, and a member without it is incomplete
 * — named individually, because averaging the difference away hides the one member a
 * downstream step will fail on. A suffix only some members carry is variation, and
 * expects nothing.
 */
export function assessCompleteness(members: readonly MemberFile[]): { members: SetMember[]; completeness: SetCompleteness } {
    const counts = new Map<string, number>();
    for (const member of members) {
        for (const suffix of new Set(member.companions.map((companion) => companion.suffix))) {
            counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
        }
    }

    const expectedCompanions = [...counts.entries()]
        .filter(([, count]) => count > members.length * EXPECTED_COMPANION_SHARE)
        .map(([suffix]) => suffix)
        .sort((a, b) => a.localeCompare(b, "en"));

    const assessed: SetMember[] = members.map((member) => {
        const carried = new Set(member.companions.map((companion) => companion.suffix));
        return { ...member, missingCompanions: expectedCompanions.filter((suffix) => !carried.has(suffix)) };
    });

    const incomplete = assessed.filter((member) => member.missingCompanions.length > 0);
    return {
        members: assessed,
        completeness: {
            expectedCompanions,
            completeMembers: assessed.length - incomplete.length,
            incompleteMembers: incomplete.length,
            incompleteSample: incomplete.slice(0, MAX_INCOMPLETE_SAMPLE).map((member) => ({ path: member.path, missingCompanions: member.missingCompanions })),
        },
    };
}
