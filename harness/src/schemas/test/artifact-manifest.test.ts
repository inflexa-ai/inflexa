import { describe, expect, it } from "bun:test";

import { inferArtifactType } from "../artifact-manifest.js";

describe("inferArtifactType", () => {
    it("gives the type of a file from its extension, in any folder", () => {
        expect(inferArtifactType("volcano.png")).toBe("figure");
        expect(inferArtifactType("work/de/a.py")).toBe("script");
        expect(inferArtifactType("work/run.log")).toBe("log");
        expect(inferArtifactType("/a1/runs/r1/s1/work/n.ipynb")).toBe("notebook");
    });

    it("ignores the case of the extension", () => {
        expect(inferArtifactType("work/qc.R")).toBe(inferArtifactType("work/qc.r"));
    });

    it("gives output to a file with no known extension", () => {
        expect(inferArtifactType("work/results.csv")).toBe("output");
        expect(inferArtifactType("work/figures/README")).toBe("output");
        expect(inferArtifactType("work/.hidden")).toBe("output");
    });
});
