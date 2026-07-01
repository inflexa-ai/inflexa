import { describe, expect, test } from "bun:test";

import { describeContext, type ResolvedContext } from "./context.ts";
import type { Analysis } from "../../types/analysis.ts";
import { asStr256 } from "../../lib/types.ts";

function analysis(name: string): Analysis {
    return {
        id: "a1",
        createdAt: 0,
        updatedAt: 0,
        name: asStr256(name),
        slug: "slug",
        outputDirectory: null,
        anchorId: "anchor1",
        projectId: null,
    };
}

describe("describeContext", () => {
    test("analysis: names the analysis and its anchor path", () => {
        const summary = describeContext({ kind: "analysis", analysis: analysis("My A"), anchorPath: "/home/x" });
        expect(summary).toContain('analysis "My A"');
        expect(summary).toContain("/home/x");
    });

    test("anchor: pluralizes the analysis count (1 analysis vs 2 analyses)", () => {
        expect(describeContext({ kind: "anchor", anchorPath: "/p", analyses: [analysis("a")] })).toContain("1 analysis");
        expect(describeContext({ kind: "anchor", anchorPath: "/p", analyses: [analysis("a"), analysis("b")] })).toContain("2 analyses");
    });

    test("pick: pluralizes candidates, treating 0 as plural", () => {
        expect(describeContext({ kind: "pick", analyses: [] })).toContain("0 candidates");
    });

    test("copy: flags the copied folder for re-mint/fork", () => {
        const ctx: ResolvedContext = { kind: "copy", cwd: "/c", marker: { schemaVersion: 1, anchorId: "anchor1" } };
        expect(describeContext(ctx)).toContain("re-mint or fork");
    });

    test("empty: reports nothing-here for the cwd", () => {
        expect(describeContext({ kind: "empty", cwd: "/nowhere" })).toContain("/nowhere");
    });
});
