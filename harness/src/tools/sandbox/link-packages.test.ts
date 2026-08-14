import { describe, expect, it } from "bun:test";

import type { ExtendAnalysisFarm, PackageRequest, PackageRequestOutcome } from "../../sandbox/types.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";

import { createLinkPackagesTool } from "./link-packages.js";

interface SeamCall {
    readonly analysisId: string;
    readonly requests: readonly PackageRequest[];
}

/** A realization that records what it was asked and answers per request. */
function fakeSeam(calls: SeamCall[], answer: (request: PackageRequest) => PackageRequestOutcome): ExtendAnalysisFarm {
    return async (analysisId, requests) => {
        calls.push({ analysisId, requests });
        return requests.map(answer);
    };
}

describe("createLinkPackagesTool", () => {
    it("sends an import name as an import request and reports the distribution it resolved to", async () => {
        // `sklearn` is not `scikit-learn`: the step holds the module name from its
        // ImportError, and the seam is what maps it back onto a distribution.
        const calls: SeamCall[] = [];
        const tool = createLinkPackagesTool({
            analysisId: "analysis-001",
            extendAnalysisFarm: fakeSeam(calls, () => ({ kind: "linked", requested: "sklearn", name: "scikit-learn", version: "1.5.2" })),
        });

        const result = (await tool.execute({ imports: ["sklearn"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(calls).toEqual([{ analysisId: "analysis-001", requests: [{ kind: "import", module: "sklearn" }] }]);
        expect(result.outcomes).toEqual([{ kind: "linked", requested: "sklearn", name: "scikit-learn", version: "1.5.2" }]);
        expect(result.message).toContain("importable now");
    });

    it("refuses an unknown name with the reason the seam gave, and names the host as the acquirer", async () => {
        const calls: SeamCall[] = [];
        const tool = createLinkPackagesTool({
            analysisId: "analysis-001",
            extendAnalysisFarm: fakeSeam(calls, () => ({
                kind: "absent",
                requested: "definitely-not-a-package",
                reason: "The pool holds no distribution of that name.",
                acquisitionPossible: true,
            })),
        });

        const result = (await tool.execute({ distributions: ["definitely-not-a-package"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.outcomes[0]).toEqual({
            kind: "absent",
            requested: "definitely-not-a-package",
            reason: "The pool holds no distribution of that name.",
            acquisitionPossible: true,
        });
        expect(result.message).toContain("host action");
        // An acquisition is possible for this ecosystem, so the dead-end note stays off.
        expect(result.message).not.toContain("cannot acquire at all");
    });

    it("marks an ecosystem the store cannot acquire, so no retry is invited", async () => {
        const tool = createLinkPackagesTool({
            analysisId: "analysis-001",
            extendAnalysisFarm: fakeSeam([], () => ({
                kind: "absent",
                requested: "DESeq2",
                reason: "The catalog does not carry this R package.",
                acquisitionPossible: false,
            })),
        });

        const result = (await tool.execute({ distributions: ["DESeq2"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.message).toContain("cannot acquire at all");
    });

    it("tells the caller to report a version collision and stop", async () => {
        const tool = createLinkPackagesTool({
            analysisId: "analysis-001",
            extendAnalysisFarm: fakeSeam([], () => ({
                kind: "collision",
                requested: "pandas==1.5.3",
                name: "pandas",
                linkedDirectory: "pandas-2.2.1",
                requestedDirectory: "pandas-1.5.3",
            })),
        });

        const result = (await tool.execute({ distributions: ["pandas==1.5.3"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.outcomes[0]).toMatchObject({ kind: "collision", linkedDirectory: "pandas-2.2.1", requestedDirectory: "pandas-1.5.3" });
        expect(result.message).toContain("no retry of that request can succeed");
        expect(result.message).toContain("stop");
    });

    it("carries a pinned requirement verbatim, and orders distributions before imports", async () => {
        const calls: SeamCall[] = [];
        const tool = createLinkPackagesTool({
            analysisId: "analysis-042",
            extendAnalysisFarm: fakeSeam(calls, () => ({ kind: "present", requested: "x", name: "x", version: "1" })),
        });

        await tool.execute({ distributions: ["polars==1.2", " numpy "], imports: ["sklearn"] }, makeToolContext().ctx);

        expect(calls[0]!.requests).toEqual([
            { kind: "distribution", requirement: "polars==1.2" },
            { kind: "distribution", requirement: "numpy" },
            { kind: "import", module: "sklearn" },
        ]);
    });

    it("names no package, thus it never reaches the seam", async () => {
        const calls: SeamCall[] = [];
        const tool = createLinkPackagesTool({
            analysisId: "analysis-001",
            extendAnalysisFarm: fakeSeam(calls, () => ({ kind: "present", requested: "x", name: "x", version: "1" })),
        });

        const result = (await tool.execute({ distributions: ["  "] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(calls).toHaveLength(0);
        expect(result.outcomes).toEqual([]);
        expect(result.message).toContain("No package was named");
    });
});
