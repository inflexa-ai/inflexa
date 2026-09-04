import { describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createLinkPackagesTool } from "./link-packages.js";
import type { PackageQuery } from "../../sandbox/package-identity.js";

/** A seam that records what it received and links every query it is given. */
function recordingSeam(): {
    calls: Array<{ analysisId: string; queries: PackageQuery[] }>;
    extendAnalysisFarm: (a: string, q: readonly PackageQuery[]) => Promise<{ kind: "linked"; spelling: string; version: string }[]>;
} {
    const calls: Array<{ analysisId: string; queries: PackageQuery[] }> = [];
    return {
        calls,
        extendAnalysisFarm: async (analysisId, queries) => {
            calls.push({ analysisId, queries: [...queries] });
            return queries.map((query) => ({ kind: "linked" as const, spelling: query.spelling, version: query.version ?? "1.0.0" }));
        },
    };
}

describe("link_packages — the query grammar", () => {
    it("a prefixed entry reaches the seam as a qualified query", async () => {
        const seam = recordingSeam();
        const tool = createLinkPackagesTool({ extendAnalysisFarm: seam.extendAnalysisFarm, analysisId: "an-42" });

        const result = (await tool.execute({ packages: ["r:Seurat"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(seam.calls).toEqual([{ analysisId: "an-42", queries: [{ spelling: "Seurat", track: "r" }] }]);
        expect(result).toEqual({ outcomes: [{ kind: "linked", spelling: "Seurat", version: "1.0.0" }] });
    });

    it("a bare entry, a pin, and a prefixed pin all reach the seam as parsed", async () => {
        const seam = recordingSeam();
        const tool = createLinkPackagesTool({ extendAnalysisFarm: seam.extendAnalysisFarm, analysisId: "an-42" });

        (await tool.execute({ packages: ["scanpy", "numpy==1.26.4", "python:igraph==1.0.0"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(seam.calls[0]!.queries).toEqual([
            { spelling: "scanpy" },
            { spelling: "numpy", version: "1.26.4" },
            { spelling: "igraph", track: "python", version: "1.0.0" },
        ]);
    });

    it("an entry that does not parse refuses the call, and no link lands", async () => {
        const seam = recordingSeam();
        const tool = createLinkPackagesTool({ extendAnalysisFarm: seam.extendAnalysisFarm, analysisId: "an-42" });

        const result = await tool.execute({ packages: ["scanpy", "bioc:fgsea"] }, makeToolContext().ctx);

        expect(result.isErr()).toBe(true);
        const issue = result._unsafeUnwrapErr();
        expect(issue.error).toContain("bioc:fgsea");
        expect(issue.error).toContain('"python:"');
        expect(issue.error).toContain('"r:"');
        expect(seam.calls).toEqual([]);
    });

    it("a location and a range specifier each refuse the call with the offending entry", async () => {
        const seam = recordingSeam();
        const tool = createLinkPackagesTool({ extendAnalysisFarm: seam.extendAnalysisFarm, analysisId: "an-42" });

        const location = await tool.execute({ packages: ["/mnt/libs/store/scanpy-1.12.3-e71bae79"] }, makeToolContext().ctx);
        const range = await tool.execute({ packages: ["numpy>=1.26"] }, makeToolContext().ctx);

        expect(location._unsafeUnwrapErr().error).toContain("/mnt/libs/store/scanpy-1.12.3-e71bae79");
        expect(range._unsafeUnwrapErr().error).toContain(">=");
        expect(seam.calls).toEqual([]);
    });

    it("a realization throw reads as unavailable per query, echoing each spelling", async () => {
        const tool = createLinkPackagesTool({
            extendAnalysisFarm: async () => {
                throw new Error("the dependency graph is unreadable");
            },
            analysisId: "an-42",
        });

        const result = (await tool.execute({ packages: ["scanpy", "r:GO.db"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result).toEqual({
            outcomes: [
                { kind: "unavailable", spelling: "scanpy", reason: "the dependency graph is unreadable" },
                { kind: "unavailable", spelling: "GO.db", reason: "the dependency graph is unreadable" },
            ],
        });
    });

    it("the description names the prefixed retry", () => {
        const tool = createLinkPackagesTool({ extendAnalysisFarm: async () => [], analysisId: "an-42" });

        expect(tool.description).toContain("call this tool again for that package with the prefixed form, `python:<name>` or `r:<name>`");
    });
});
