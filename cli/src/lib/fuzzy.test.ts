import { describe, expect, test } from "bun:test";

import { rankBy, subsequenceScore } from "./fuzzy.ts";

// These tests pin the scorer's CONTRACT, not its exact score magnitudes. They assert sign and
// relative ordering only, so the scoring constants can be re-tuned without rewriting the suite.
describe("subsequenceScore", () => {
    test("a subsequence match scores >= 0", () => {
        expect(subsequenceScore("tn", "tokyo-night")).toBeGreaterThanOrEqual(0);
        expect(subsequenceScore("open", "Open output folder")).toBeGreaterThanOrEqual(0);
    });

    test("a non-subsequence scores -1", () => {
        expect(subsequenceScore("zx", "tokyo-night")).toBe(-1);
        // All chars present but out of order is NOT a subsequence.
        expect(subsequenceScore("nt", "tn")).toBe(-1);
    });

    test("an empty query is the neutral 0 regardless of target", () => {
        expect(subsequenceScore("", "anything")).toBe(0);
        expect(subsequenceScore("", "")).toBe(0);
    });

    test("matching is case-insensitive", () => {
        expect(subsequenceScore("OP", "Open output")).toBeGreaterThanOrEqual(0);
        expect(subsequenceScore("op", "OPEN OUTPUT")).toBeGreaterThanOrEqual(0);
    });

    test("a contiguous match outscores a scattered one", () => {
        expect(subsequenceScore("cat", "cat")).toBeGreaterThan(subsequenceScore("cat", "c_a_t"));
    });

    test("a hit at the start of target outscores a mid-string hit", () => {
        // "ana" starts "analysis" but appears mid-string in "an analysis".
        expect(subsequenceScore("ana", "analysis")).toBeGreaterThan(subsequenceScore("ana", "_analysis"));
    });
});

describe("rankBy", () => {
    type Row = { title: string; category?: string };
    const fields = [
        { get: (r: Row) => r.title, weight: 2 },
        { get: (r: Row) => r.category ?? "", weight: 1 },
    ];

    test("a title match outranks a category-only match", () => {
        const rows: Row[] = [
            { title: "zzz", category: "open" }, // matches only on category
            { title: "open", category: "zzz" }, // matches on the higher-weighted title
        ];
        expect(rankBy(rows, "open", fields)[0]!.title).toBe("open");
    });

    test("rows matching no field are dropped", () => {
        const rows: Row[] = [
            { title: "open", category: "view" },
            { title: "quit", category: "app" },
        ];
        const ranked = rankBy(rows, "open", fields);
        expect(ranked).toHaveLength(1);
        expect(ranked[0]!.title).toBe("open");
    });

    test("an empty query returns items unchanged in original order", () => {
        const rows: Row[] = [{ title: "b" }, { title: "a" }];
        expect(rankBy(rows, "", fields)).toEqual(rows);
    });

    test("ties preserve original order", () => {
        const rows: Row[] = [{ title: "open one" }, { title: "open two" }];
        expect(rankBy(rows, "open", fields).map((r) => r.title)).toEqual(["open one", "open two"]);
    });
});
