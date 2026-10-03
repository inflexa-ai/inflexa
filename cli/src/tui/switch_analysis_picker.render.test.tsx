import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";

import type { AnalysisList, AnalysisSummary } from "../api/analyses.ts";
import type { UsageTotals } from "../api/usage.ts";
import { __setClipboardWriterForTest } from "../lib/clipboard.ts";
import { contractHome } from "../lib/paths.ts";
import { fakeClient } from "../test_support/fake_client.ts";
import { useKeymapRoot } from "./keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { DEFAULT_ANALYSIS_DIALOG_OPTS, openSwitchAnalysis, type AnalysisDialogOpts } from "./commands.tsx";
import type { Analysis } from "../types/analysis.ts";

// The Switch analysis picker is the ONE place the interface reports a whole-analysis total, so this drives
// the REAL flow (`analysis.switch` → its dialog) against a fake client of the server: the claim is that each
// row shows the figures and the folder that `GET /api/v1/analyses` gives for it, and that a row with no
// figures stays listed. The grouped ledger read itself is tested in `server/routes/analyses.test.ts`.

let dirA = "";
let dirB = "";
let rows: AnalysisSummary[] = [];

beforeEach(() => {
    // realpath so the folders match the canonical form that the server gives, on macOS too.
    dirA = realpathSync(mkdtempSync(join(tmpdir(), "switch-a-")));
    dirB = realpathSync(mkdtempSync(join(tmpdir(), "switch-b-")));
    rows = [];
});

afterEach(() => {
    dialogClear();
    for (const dir of [dirA, dirB]) rmSync(dir, { recursive: true, force: true });
});

let next = 0;

/** One row of `GET /api/v1/analyses`, in the folder `dir`, newest last. */
function analysisIn(dir: string, name: string, usage?: UsageTotals): AnalysisSummary {
    next += 1;
    const row: AnalysisSummary = {
        id: `analysis-${next}`,
        createdAt: new Date(Date.UTC(2026, 8, next)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 8, next)).toISOString(),
        name,
        slug: name.toLowerCase(),
        anchorId: `anchor-${dir}`,
        projectId: null,
        anchorPath: dir,
        ...(usage === undefined ? {} : { usage }),
    };
    rows.unshift(row);
    return row;
}

/** The picker options over a fake server that lists `rows`, with `open` as the in-place open. */
function dialogOpts(open: AnalysisDialogOpts["openAnalysis"] = DEFAULT_ANALYSIS_DIALOG_OPTS.openAnalysis): AnalysisDialogOpts {
    const client = fakeClient((req) => {
        if (req.method === "GET" && req.path.startsWith("/api/v1/analyses?")) {
            const list: AnalysisList = { analyses: rows, total: rows.length, page: 0, perPage: 200, hasMore: false };
            return { status: 200, body: list };
        }
        return { status: 404, body: { error: "not_found", message: `No route for ${req.method} ${req.path}.` } };
    });
    return { client: client.opts, openAnalysis: open };
}

function ws(): Workspace {
    return {
        analysis: null,
        sessionId: null,
        workingDir: dirA,
        project: null,
        anchor: null,
        inputCount: null,
        openDialog: () => {},
        closeDialog: () => {},
        openSession: () => {},
        refreshScope: () => {},
        quit: async () => {},
    };
}

/** The dialog host under a given workspace — closed over rather than passed as a prop, so the
 *  Provider's value is a plain constant (the shape `sidebar.render.test.tsx` uses). */
function harnessNode(workspace: Workspace): () => JSX.Element {
    return () => {
        useKeymapRoot();
        return (
            <WorkspaceContext.Provider value={workspace}>
                <box width="100%" height="100%">
                    <DialogOverlay />
                </box>
            </WorkspaceContext.Provider>
        );
    };
}

type Setup = Awaited<ReturnType<typeof testRender>>;

// A real-clock settle: the dialog host applies focus on a microtask and the list's seeded scroll
// retries on a macrotask, so a bare render pair is too early for both.
async function settle(setup: Setup): Promise<string> {
    await new Promise((r) => setTimeout(r, 20));
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

/** Run the real `analysis.switch` flow against the fake server and push the dialog it opens onto the host. */
async function openSwitchPicker(workspace: Workspace, opts: AnalysisDialogOpts = dialogOpts()): Promise<void> {
    await openSwitchAnalysis({ ...workspace, openDialog: (render) => dialogPush(render) }, opts);
}

describe("Switch analysis picker figures", () => {
    test("each row carries its OWN analysis's total, and an analysis with none carries no figure", async () => {
        analysisIn(dirA, "rna-seq", { calls: 1, inputTokens: 767_600, outputTokens: 33_100 });
        // An analysis with no recorded calls: the ledger gives a zero count and no quantity.
        analysisIn(dirB, "atac-seq", { calls: 0 });

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            await openSwitchPicker(workspace);
            const frame = await settle(setup);

            const spentRow = frame.split("\n").find((l) => l.includes("rna-seq"));
            const untouchedRow = frame.split("\n").find((l) => l.includes("atac-seq"));
            expect(spentRow).toBeDefined();
            expect(untouchedRow).toBeDefined();

            expect(spentRow).toContain("↑767.6k ↓33.1k");
            // Never a zero, and never the other analysis's number: absence is absence. The arrows ARE
            // the figure — asserting on bare digits would catch the row's creation date instead, which
            // every row carries and which says nothing about usage.
            expect(untouchedRow).not.toContain("↑");
            expect(untouchedRow).not.toContain("↓");
            // 800.7k is the two arms added — a figure no surface may invent.
            expect(frame).not.toContain("800.7k");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("every analysis stays listed and selectable, figures or not", async () => {
        analysisIn(dirA, "rna-seq");
        analysisIn(dirB, "atac-seq", { calls: 1, outputTokens: 40 });

        // The open of the selected analysis is the option the flow takes, thus the spy is there.
        let chosen: Analysis | null = null;
        const opts = dialogOpts(async (_ws, analysis) => {
            chosen = analysis;
        });
        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            await openSwitchPicker(workspace, opts);
            await settle(setup);

            // A half figure keeps the arm it has rather than inventing the one it lacks. Asserted on
            // the ROW, not the frame: the list's own footer hint spells its move keys with arrows.
            const row = setup
                .captureCharFrame()
                .split("\n")
                .find((l) => l.includes("atac-seq"));
            expect(row).toContain("↓40");
            expect(row).not.toContain("↑");

            setup.mockInput.pressEnter();
            await settle(setup);
            expect(chosen).not.toBeNull();
        } finally {
            setup.renderer.destroy();
        }
    });
});

// A full run of this file emits one `Anchor is the same as the node <id> being inserted, skipping
// insertBefore` from opentui. It appears only with grouping on, and only across a multi-test run —
// no single test or pair reproduces it. It is NOT the row-drop of HORRIBLE_BUG_FIXES entry 1: that
// one is the `Anchor with id <id> does not exist` branch, which skips a node not yet in the tree.
// This branch is `renderable === anchor`, i.e. inserting a node before ITSELF, where skipping is
// what the operation already means. Every row and header asserted below renders, and the
// for_scrollbox sentinel (which covers grouped tuples) stays green.
describe("Switch analysis picker identity", () => {
    test("two analyses of one name are told apart by their anchor headers", async () => {
        // The reason this grouping exists: a slug is unique only WITHIN an anchor, so the same name
        // in two folders produces two rows that are identical down to the character.
        const inA = analysisIn(dirA, "A1");
        const inB = analysisIn(dirB, "A1");

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            await openSwitchPicker(workspace);
            const frame = await settle(setup);

            const lines = frame.split("\n");
            expect(lines.filter((l) => l.includes("A1") && !l.includes(dirA) && !l.includes(dirB))).toHaveLength(2);
            const headers = lines.filter((l) => l.includes(dirA) || l.includes(dirB));
            expect(headers).toHaveLength(2);
            expect(headers.join("\n")).toContain(contractHome(dirA));
            expect(headers.join("\n")).toContain(contractHome(dirB));
            // The group KEY is the anchor id, and a header must print the folder instead. (The id is
            // on screen — the cursor row's detail line carries it deliberately — so this asks the
            // narrower question the grouping actually owns.)
            expect(headers.join("\n")).not.toContain(inA.anchorId);
            expect(headers.join("\n")).not.toContain(inB.anchorId);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the row date is absolute, and the cursor row gives the id and the slug", async () => {
        const only = analysisIn(dirA, "rna-seq");

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 110, height: 24 });
        try {
            await settle(setup);
            await openSwitchPicker(workspace);
            const frame = await settle(setup);

            const row = frame.split("\n").find((l) => l.includes("rna-seq")) ?? "";
            expect(row).toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
            // A record listing reads on the absolute side of the time convention.
            expect(row).not.toMatch(/\b\d+[dhm] ago\b/);

            // The detail line of the cursor row is the one unambiguous handle for a row.
            expect(frame).toContain(only.id);
            expect(frame).toContain(only.slug);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("ctrl+y copies the cursor row's analysis id", async () => {
        const only = analysisIn(dirA, "rna-seq");
        const copied: string[] = [];
        const restore = __setClipboardWriterForTest(async (text) => {
            copied.push(text);
        });

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            await openSwitchPicker(workspace);
            await settle(setup);

            await setup.mockInput.pressKeys(["\x19"]); // ctrl+y
            await settle(setup);
            expect(copied).toEqual([only.id]);
        } finally {
            restore();
            setup.renderer.destroy();
        }
    });

    test("a typed y filters instead of copying — the chord needs ctrl", async () => {
        analysisIn(dirA, "rna-seq");
        analysisIn(dirB, "yeast");
        const copied: string[] = [];
        const restore = __setClipboardWriterForTest(async (text) => {
            copied.push(text);
        });

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            await openSwitchPicker(workspace);
            await settle(setup);

            await setup.mockInput.pressKeys(["y"]);
            const frame = await settle(setup);
            expect(copied).toEqual([]);
            expect(frame).toContain("yeast");
        } finally {
            restore();
            setup.renderer.destroy();
        }
    });
});
