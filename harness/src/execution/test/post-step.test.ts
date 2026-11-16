import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { walkStepArtifacts } from "../post-step.js";

describe("walkStepArtifacts", () => {
    let base: string | undefined;

    afterEach(async () => {
        if (base !== undefined) await rm(base, { recursive: true, force: true });
        base = undefined;
    });

    it("types and hashes the files of a step by their extension, relative to the step directory, and leaves out the summary of the host", async () => {
        base = await mkdtemp(join(tmpdir(), "cortex-walk-step-"));
        const stepDir = join(base, "runs", "run-1", "T1S1");
        const files = ["work/de/analysis.py", "work/de/results.csv", "work/plots/volcano.png", "work/run.log", "summary.md"];
        for (const file of files) {
            await mkdir(dirname(join(stepDir, file)), { recursive: true });
            await writeFile(join(stepDir, file), `content of ${file}`);
        }

        const manifest = await walkStepArtifacts({ stepDir, stepId: "T1S1", runId: "run-1" });

        const typeByPath = Object.fromEntries(manifest.map((entry) => [entry.path, entry.type]));
        expect(typeByPath).toEqual({
            "work/de/analysis.py": "script",
            "work/de/results.csv": "output",
            "work/plots/volcano.png": "figure",
            "work/run.log": "log",
        });
        expect(manifest.every((entry) => entry.stepId === "T1S1" && entry.runId === "run-1")).toBe(true);
        expect(manifest.every((entry) => typeof entry.hash === "string" && entry.hash.length > 0)).toBe(true);
    });
});
