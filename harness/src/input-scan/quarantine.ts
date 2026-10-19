/**
 * Stage 0 — junk and partial artifacts leave before structure is observed.
 *
 * A partial-download twin sitting beside its completed file has the completed file's
 * stem, so template mining absorbs it into the set and the set's member count then
 * counts a file that holds nothing. The exclusion has to happen first, and it has to
 * be reported: a wrongly quarantined file that no one can see is worse than the junk.
 */

import type { QuarantineReason, QuarantineSummary } from "./set-types.js";
import type { ScannedFile } from "./types.js";
import { isHex, isUuid } from "../lib/text.js";
import { MAX_QUARANTINE_SAMPLE } from "./tuning.js";

const EXACT_JUNK_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const NAME_RULES: readonly { readonly matches: (name: string) => boolean; readonly reason: QuarantineReason }[] = [
    { matches: (name) => name.startsWith("._"), reason: "os-junk" },
    { matches: (name) => name.startsWith("~$"), reason: "editor-temp" },
    { matches: (name) => name.endsWith("~"), reason: "editor-temp" },
    { matches: (name) => name.startsWith(".~lock.") && name.endsWith("#"), reason: "editor-temp" },
    { matches: (name) => name.endsWith(".swp"), reason: "editor-temp" },
    { matches: (name) => name.endsWith(".part"), reason: "partial-download" },
    { matches: (name) => name.endsWith(".filepart"), reason: "partial-download" },
    { matches: (name) => name.endsWith(".crdownload"), reason: "partial-download" },
    { matches: (name) => name.endsWith(".download"), reason: "partial-download" },
    { matches: (name) => name.endsWith(".tmp"), reason: "atomic-write-temp" },
    { matches: (name) => name.startsWith(".nfs"), reason: "atomic-write-temp" },
    {
        matches: (name) => {
            const marker = name.lastIndexOf(".tmp-");
            return marker >= 0 && isUuid(name.slice(marker + 5));
        },
        reason: "atomic-write-temp",
    },
    {
        matches: (name) => {
            const marker = name.lastIndexOf(".tmp-");
            return marker >= 0 && name.length - marker - 5 >= 8 && isHex(name.slice(marker + 5));
        },
        reason: "atomic-write-temp",
    },
];

const SEGMENT_RULES: readonly { readonly matches: (segment: string) => boolean; readonly reason: QuarantineReason }[] = [
    { matches: (segment) => segment === "__MACOSX", reason: "os-junk" },
    { matches: (segment) => segment.startsWith(".Trash-"), reason: "os-junk" },
];

/** The rule a path trips, or `undefined` when it trips none. */
export function quarantineReason(path: string): QuarantineReason | undefined {
    const segments = path.split("/");
    const name = segments[segments.length - 1];
    if (EXACT_JUNK_NAMES.has(name)) return "os-junk";
    for (const rule of NAME_RULES) if (rule.matches(name)) return rule.reason;
    for (const segment of segments) for (const rule of SEGMENT_RULES) if (rule.matches(segment)) return rule.reason;
    return undefined;
}

export type QuarantineResult = {
    readonly kept: readonly ScannedFile[];
    readonly summary: QuarantineSummary;
};

export function quarantine(files: readonly ScannedFile[]): QuarantineResult {
    const kept: ScannedFile[] = [];
    const excluded: { file: ScannedFile; reason: QuarantineReason }[] = [];
    for (const file of files) {
        const reason = quarantineReason(file.path);
        if (reason) excluded.push({ file, reason });
        else kept.push(file);
    }

    const counts = new Map<QuarantineReason, number>();
    for (const entry of excluded) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);

    return {
        kept,
        summary: {
            count: excluded.length,
            totalBytes: excluded.reduce((total, entry) => total + entry.file.size, 0),
            reasons: [...counts.entries()]
                .map(([reason, count]) => ({ reason, count }))
                .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "en")),
            sample: excluded.slice(0, MAX_QUARANTINE_SAMPLE).map((entry) => entry.file.path),
        },
    };
}
