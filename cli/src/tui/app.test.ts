import { describe, expect, test } from "bun:test";

// Side-effect import: installs `Date.relativeAge` (used by the loaded-snapshot timestamp lines) via
// the same central loader the app boots with — the profile line composer calls it directly.
import "../extensions/index.ts";
import type { DataProfileStatus } from "@inflexa-ai/harness";

import { profileDetailLines } from "./app.tsx";
import type { ProfileSnapshot } from "./hooks/sidebar_live.ts";

function loaded(over: Partial<DataProfileStatus> = {}): ProfileSnapshot {
    return {
        kind: "loaded",
        profile: {
            status: "completed",
            error: null,
            startedAt: "2026-07-08T00:00:00.000Z",
            completedAt: "2026-07-08T00:00:05.000Z",
            result: {
                summary: "line one\nline two",
                files: [
                    { path: "data/counts.tsv", description: "raw counts" },
                    { path: "data/meta.csv", description: "sample metadata" },
                ],
                inputFileIds: ["i1", "i2"],
                profiledAt: "2026-07-08T00:00:05.000Z",
            },
            seedInputFileIds: ["i1", "i2", "i3"],
            ...over,
        },
    };
}

describe("profileDetailLines — one line set per snapshot kind", () => {
    test("not_ready → a single placeholder line", () => {
        expect(profileDetailLines({ kind: "not_ready" })).toEqual(["runtime not ready"]);
    });

    test("absent → not profiled yet", () => {
        expect(profileDetailLines({ kind: "absent" })).toEqual(["not profiled yet"]);
    });

    test("unavailable → status unavailable", () => {
        expect(profileDetailLines({ kind: "unavailable" })).toEqual(["profile status unavailable"]);
    });

    test("loaded completed → status, times, summary, per-file, seed count", () => {
        const lines = profileDetailLines(loaded());
        expect(lines[0]).toBe("status: completed");
        expect(lines.some((l) => l.startsWith("started "))).toBe(true);
        expect(lines.some((l) => l.startsWith("completed "))).toBe(true);
        expect(lines).toContain("line one");
        expect(lines).toContain("line two");
        expect(lines).toContain("files (2):");
        expect(lines.some((l) => l.includes("data/counts.tsv") && l.includes("raw counts"))).toBe(true);
        expect(lines.some((l) => l.includes("data/meta.csv") && l.includes("sample metadata"))).toBe(true);
        // seedInputFileIds (3) wins over the profiled inputFileIds count.
        expect(lines[lines.length - 1]).toBe("3 seed inputs");
    });

    test("loaded failed → surfaces the multi-line error", () => {
        const lines = profileDetailLines(loaded({ status: "failed", error: "boom\ndetails here", result: null, seedInputFileIds: null }));
        expect(lines[0]).toBe("status: failed");
        expect(lines).toContain("boom");
        expect(lines).toContain("details here");
        // No result + no seed set → zero, pluralized.
        expect(lines[lines.length - 1]).toBe("0 seed inputs");
    });

    test("loaded pending without a result → status + seed count, no files section", () => {
        const lines = profileDetailLines(
            loaded({ status: "pending", startedAt: "2026-07-08T00:00:00.000Z", completedAt: null, result: null, seedInputFileIds: ["only-one"] }),
        );
        expect(lines[0]).toBe("status: pending");
        expect(lines.some((l) => l.startsWith("started "))).toBe(true);
        expect(lines.some((l) => l.startsWith("completed "))).toBe(false);
        expect(lines.some((l) => l.startsWith("files ("))).toBe(false);
        // Singular when exactly one seed input.
        expect(lines[lines.length - 1]).toBe("1 seed input");
    });
});
