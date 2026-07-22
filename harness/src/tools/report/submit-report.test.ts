import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSubmitReportTool, type ReportOutcome } from "./submit-report.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";

const RENDERED = "<html><body><h1>QC</h1></body></html>";
const TEMPLATE = "<html><body><h1>{{ title }}</h1></body></html>";

describe("submit_report finalize gate", () => {
    // The builder's prompt lists hand-writing `index.html` as an anti-pattern,
    // which by itself only discourages it. A version finalized that way carries
    // no report at all, and the next iteration is handed a change request with
    // nothing to change.
    test("refuses a version holding only a hand-written index.html", async () => {
        const dirs = await makeVersionDir();
        await writeFile(join(dirs.versionDir, "index.html"), RENDERED, "utf8");

        const { output, recorded } = await submit(dirs);

        expect(output.ok).toBe(false);
        const problems = output.problems.join("\n");
        expect(problems).toContain("report.html.j2");
        expect(problems).toContain("build_report");
        // Nothing was recorded, so the runner rolls the version dir back.
        expect(recorded.outcome).toBeUndefined();
    });

    test("accepts a version carrying the template and its rendered output", async () => {
        const dirs = await makeVersionDir();
        await writeFile(join(dirs.versionDir, "report.html.j2"), TEMPLATE, "utf8");
        await writeFile(join(dirs.versionDir, "index.html"), RENDERED, "utf8");

        const { output, recorded } = await submit(dirs, { notes: ["  cohort table rendered from 8 of 12 samples  ", "   "] });

        expect(output.ok).toBe(true);
        expect(output.problems).toEqual([]);
        expect(recorded.outcome).toEqual({ ok: true, notes: ["cohort table rendered from 8 of 12 samples"] });
    });

    // An absent template is the cause; an absent `index.html` is one of its
    // symptoms. Reported the other way round, the builder is sent to
    // `build_report` for a template it never wrote.
    test("names the missing template ahead of the missing output", async () => {
        const dirs = await makeVersionDir();

        const { output, recorded } = await submit(dirs);

        expect(output.ok).toBe(false);
        expect(output.problems[0]).toContain("report.html.j2");
        expect(output.problems.join("\n")).toContain("index.html does not exist");
        expect(recorded.outcome).toBeUndefined();
    });

    test("refuses output that still carries unrendered Jinja", async () => {
        const dirs = await makeVersionDir();
        await writeFile(join(dirs.versionDir, "report.html.j2"), TEMPLATE, "utf8");
        await writeFile(join(dirs.versionDir, "index.html"), TEMPLATE, "utf8");

        const { output, recorded } = await submit(dirs);

        expect(output.ok).toBe(false);
        expect(output.problems.join("\n")).toContain("unrendered Jinja");
        expect(recorded.outcome).toBeUndefined();
    });

    test("refuses an asset reference with no file behind it", async () => {
        const dirs = await makeVersionDir();
        await writeFile(join(dirs.versionDir, "report.html.j2"), TEMPLATE, "utf8");
        await writeFile(join(dirs.versionDir, "index.html"), `<html><body><img src="assets/volcano.png"></body></html>`, "utf8");

        const { output, recorded } = await submit(dirs);

        expect(output.ok).toBe(false);
        expect(output.problems.join("\n")).toContain("assets/volcano.png");
        expect(recorded.outcome).toBeUndefined();
    });

    test("accepts an asset reference that resolves through the shared assets dir", async () => {
        const dirs = await makeVersionDir();
        await writeFile(join(dirs.assetsDir, "volcano.png"), "png-bytes", "utf8");
        await writeFile(join(dirs.versionDir, "report.html.j2"), TEMPLATE, "utf8");
        await writeFile(join(dirs.versionDir, "index.html"), `<html><body><img src="assets/volcano.png"></body></html>`, "utf8");

        const { output, recorded } = await submit(dirs);

        expect(output.problems).toEqual([]);
        expect(output.ok).toBe(true);
        expect(recorded.outcome).toEqual({ ok: true, notes: [] });
    });
});

// ── helpers ─────────────────────────────────────────────────────────

interface VersionDirs {
    readonly versionDir: string;
    readonly assetsDir: string;
}

/** The layout the runner prepares: `v1/` beside the preview's shared `assets/`, symlinked in. */
async function makeVersionDir(): Promise<VersionDirs> {
    const previewRoot = await mkdtemp(join(tmpdir(), "submit-report-gate-"));
    const versionDir = join(previewRoot, "v1");
    const assetsDir = join(previewRoot, "assets");
    await mkdir(versionDir);
    await mkdir(assetsDir);
    await symlink("../assets", join(versionDir, "assets"), "dir");
    return { versionDir, assetsDir };
}

type GateOutput = { ok: boolean; problems: string[] };

async function submit(dirs: VersionDirs, input: Record<string, unknown> = {}): Promise<{ output: GateOutput; recorded: { outcome?: ReportOutcome } }> {
    const recorded: { outcome?: ReportOutcome } = {};
    const tool = createSubmitReportTool({
        versionDir: dirs.versionDir,
        assetsDir: dirs.assetsDir,
        setOutcome: (outcome) => {
            recorded.outcome = outcome;
        },
    });
    const result = await tool.execute(input, makeToolContext().ctx);
    return { output: result._unsafeUnwrap() as GateOutput, recorded };
}
