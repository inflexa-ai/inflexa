import { describe, expect, it } from "bun:test";

import { inferArtifactType } from "./artifact-manifest.js";

describe("inferArtifactType", () => {
    it("gives the type of a top-level folder of the step", () => {
        expect(inferArtifactType("figures/volcano.png")).toBe("figure");
        expect(inferArtifactType("scripts/a.py")).toBe("script");
        expect(inferArtifactType("logs/run.log")).toBe("log");
        expect(inferArtifactType("notebooks/n.ipynb")).toBe("notebook");
    });

    it("gives the type of a nested folder", () => {
        expect(inferArtifactType("output/figures/volcano.png")).toBe("figure");
    });

    it("gives the same type to a rooted path", () => {
        expect(inferArtifactType("/a1/runs/r1/s1/figures/volcano.png")).toBe("figure");
    });

    it("gives output to a file outside the typed folders", () => {
        expect(inferArtifactType("output/results.csv")).toBe("output");
        expect(inferArtifactType("summary.md")).toBe("output");
        expect(inferArtifactType("figures_raw/x.png")).toBe("output");
        expect(inferArtifactType("output/my_figures/x.png")).toBe("output");
    });
});
