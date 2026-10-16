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

    it("types and hashes the agent-written and command-produced files of a step by their folder", async () => {
        base = await mkdtemp(join(tmpdir(), "cortex-walk-step-"));
        const writePrefix = join(base, "runs", "run-1", "T1S1");
        const files = ["scripts/analysis.py", "output/results.csv", "figures/volcano.png", "logs/run.log"];
        for (const file of files) {
            await mkdir(dirname(join(writePrefix, file)), { recursive: true });
            await writeFile(join(writePrefix, file), `content of ${file}`);
        }

        const manifest = await walkStepArtifacts({ writePrefix, stepId: "T1S1", runId: "run-1" });

        const typeByPath = Object.fromEntries(manifest.map((entry) => [entry.path, entry.type]));
        expect(typeByPath).toEqual({
            "scripts/analysis.py": "script",
            "output/results.csv": "output",
            "figures/volcano.png": "figure",
            "logs/run.log": "log",
        });
        expect(manifest.every((entry) => entry.stepId === "T1S1" && entry.runId === "run-1")).toBe(true);
        expect(manifest.every((entry) => typeof entry.hash === "string" && entry.hash.length > 0)).toBe(true);
    });
});
