/**
 * Body-level unit tests for the `sandbox-step` handoff-briefing composition
 * (see the conversation-briefings spec). The two composition seams are exported
 * from the workflow module so they can be driven without a DBOS engine:
 *
 *   - `loadHandoffPayloads` — the I/O the body runs inside the checkpointed
 *     `handoff.load` durable step: read each upstream summary via the workspace
 *     read seam, walk its artifact tree, drop absent-summary edges.
 *   - `composeInitialMessages` — the pure composition of the loop's initial
 *     messages: one wrapped `<briefing name="step-handoff">` per payload, in
 *     order, ahead of the step prompt.
 *
 * The body wires them as
 *   `composeInitialMessages(input.prompt, safe(loadHandoffPayloads(...)))`,
 * so a degraded load (empty payloads) composes prompt-only — proven here by the
 * empty-payload and read-failure cases.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";

import type { RunSession } from "../auth/types.js";
import type { FsError } from "../lib/fs-result.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { StepHandoffInput } from "../prompts/briefings/index.js";
import { composeInitialMessages, loadHandoffPayloads } from "./sandbox-step.js";

const S2_SUMMARY = "## Normalize\n\nMedian-of-ratios normalization applied; 22,979 genes retained.";
const SESSION = {} as RunSession; // only forwarded to the (faked) read seam

/** A workspace read seam that returns a summary for `s2` and not_found for anything else. */
function fakeWorkspaceFs(present: Record<string, string>): WorkspaceFilesystem {
    return {
        readFile: ({ path }) => {
            const hit = Object.entries(present).find(([stepId]) => path.includes(`/${stepId}/`));
            if (!hit) return okAsync({ kind: "not_found" as const });
            return okAsync({ kind: "ok" as const, content: Buffer.from(hit[1]), truncated: false as const });
        },
    } as unknown as WorkspaceFilesystem;
}

describe("composeInitialMessages", () => {
    const payload = (stepId: string): StepHandoffInput => ({
        stepId,
        name: `${stepId}-name`,
        summaryMarkdown: `summary of ${stepId}`,
        artifactPaths: [`/A/runs/r/${stepId}/output/x.csv`],
    });

    it("prepends one wrapped step-handoff briefing per payload, in order, ahead of the prompt", () => {
        const messages = composeInitialMessages("STEP PROMPT", [payload("s1"), payload("s2")]);

        expect(messages).toHaveLength(3);
        const c0 = messages[0]!.content as string;
        const c1 = messages[1]!.content as string;
        expect(c0.startsWith('<briefing name="step-handoff">')).toBe(true);
        expect(c0).toContain("summary of s1");
        expect(c1).toContain("summary of s2");
        // The step prompt is last, unwrapped.
        expect(messages[2]).toEqual({ role: "user", content: "STEP PROMPT" });
        expect(messages.every((m) => m.role === "user")).toBe(true);
    });

    it("composes prompt-only when there are no payloads (root step or degraded load)", () => {
        expect(composeInitialMessages("STEP PROMPT", [])).toEqual([{ role: "user", content: "STEP PROMPT" }]);
    });
});

describe("loadHandoffPayloads", () => {
    let root: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "handoff-load-"));
        // Upstream s2 produced a summary + three real artifacts (plus its summary.md).
        const s2 = join(root, "runs", "run1", "s2");
        await mkdir(join(s2, "output"), { recursive: true });
        await mkdir(join(s2, "scripts"), { recursive: true });
        await mkdir(join(s2, "figures"), { recursive: true });
        await writeFile(join(s2, "output", "summary.md"), S2_SUMMARY);
        await writeFile(join(s2, "output", "de.csv"), "gene,lfc\nBRCA1,2.1\n");
        await writeFile(join(s2, "scripts", "de.py"), "print('de')\n");
        await writeFile(join(s2, "figures", "volcano.png"), "PNGDATA");
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const inputFor = (sources: { stepId: string; name: string }[]) => ({
        analysisId: "A",
        runId: "run1",
        handoffSources: sources,
    });

    it("returns [] with no upstream sources", async () => {
        const payloads = await loadHandoffPayloads(
            { workspaceFs: fakeWorkspaceFs({ s2: S2_SUMMARY }), resolveWorkspaceRoot: () => root },
            SESSION,
            inputFor([]),
        );
        expect(payloads).toEqual([]);
    });

    it("omits a summary-less upstream while its summarized sibling survives", async () => {
        const payloads = await loadHandoffPayloads(
            { workspaceFs: fakeWorkspaceFs({ s2: S2_SUMMARY }), resolveWorkspaceRoot: () => root },
            SESSION,
            // s1 has no persisted summary (fake read → not_found); s2 does.
            inputFor([
                { stepId: "s1", name: "qc" },
                { stepId: "s2", name: "normalize" },
            ]),
        );

        expect(payloads).toHaveLength(1);
        expect(payloads[0]!.stepId).toBe("s2");
        expect(payloads[0]!.name).toBe("normalize");
    });

    it("embeds the persisted summary verbatim with sandbox-canonical artifact paths, summary.md excluded", async () => {
        const [payload] = await loadHandoffPayloads(
            { workspaceFs: fakeWorkspaceFs({ s2: S2_SUMMARY }), resolveWorkspaceRoot: () => root },
            SESSION,
            inputFor([{ stepId: "s2", name: "normalize" }]),
        );

        expect(payload!.summaryMarkdown).toBe(S2_SUMMARY);
        // Sorted, sandbox-canonical, summary.md dropped, no host path leaked.
        expect(payload!.artifactPaths).toEqual(["/A/runs/run1/s2/figures/volcano.png", "/A/runs/run1/s2/output/de.csv", "/A/runs/run1/s2/scripts/de.py"]);
        for (const p of payload!.artifactPaths) {
            expect(p.startsWith("/A/")).toBe(true);
            expect(p).not.toContain(root);
            expect(p).not.toContain("summary.md");
        }
    });

    it("omits an edge whose summary read fails (I/O error), degrading rather than throwing", async () => {
        const erroringFs = {
            readFile: () => errAsync({ type: "read_failed", op: "workspace.readFile", path: "x", cause: new Error("boom") } as FsError),
        } as unknown as WorkspaceFilesystem;

        const payloads = await loadHandoffPayloads(
            { workspaceFs: erroringFs, resolveWorkspaceRoot: () => root },
            SESSION,
            inputFor([{ stepId: "s2", name: "normalize" }]),
        );

        // A failed read is a per-edge omission — the load itself never throws, so
        // the body's `handoff.load` step degrades to composing prompt-only.
        expect(payloads).toEqual([]);
    });
});
