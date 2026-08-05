import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";

import { freshDb } from "../test_support/db.ts";
import { str256 } from "../lib/types.ts";
import { createAnalysis } from "../modules/analysis/analysis.ts";
import { listAnalysisInputs } from "../db/primary_query.ts";
import { useKeymapRoot } from "./keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { commands } from "./commands.tsx";
import type { Analysis } from "../types/analysis.ts";

// The flat inputs list drives the REAL `analysis.remove-input` command against a REAL database. Two
// claims are under test and neither is visible from the picker: that a batch of inputs leaves in ONE
// pass, and that a row names its input by a path the user can act on.

let anchorDir = "";
let outsideDir = "";
let analysis: Analysis;

beforeEach(() => {
    freshDb();
    // realpath so the anchor markers the analysis mints match macOS's canonical /private/var.
    anchorDir = realpathSync(mkdtempSync(join(tmpdir(), "rm-inputs-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "rm-inputs-far-")));
    writeFileSync(join(anchorDir, "counts.tsv"), "x".repeat(2048));
    mkdirSync(join(anchorDir, "data"));
    writeFileSync(join(anchorDir, "data", "inner.txt"), "x");
    writeFileSync(join(outsideDir, "matrix.mtx"), "x");
    analysis = createAnalysis({
        cwd: anchorDir,
        name: str256("rna-seq")._unsafeUnwrap(),
        inputPaths: [join(anchorDir, "counts.tsv"), join(anchorDir, "data"), join(outsideDir, "matrix.mtx")],
    })._unsafeUnwrap();
});

afterEach(() => {
    dialogClear();
    for (const dir of [anchorDir, outsideDir]) rmSync(dir, { recursive: true, force: true });
});

function ws(): Workspace {
    return {
        analysis,
        sessionId: null,
        workingDir: anchorDir,
        project: null,
        openDialog: () => {},
        closeDialog: () => {},
        openSession: () => {},
        quit: async () => {},
    };
}

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

async function settle(setup: Setup): Promise<string> {
    await new Promise((r) => setTimeout(r, 20));
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

/**
 * The frame with every space, newline, and box-drawing glyph removed. An absolute path is longer
 * than the panel, so the list wraps it mid-string and a literal `toContain` on the path can never
 * match. These paths hold no spaces, so collapsing the frame reassembles them exactly.
 */
function flat(frame: string): string {
    return frame.replace(/[\s\u2500-\u257f]/g, "");
}

/** Run the real `analysis.remove-input` command and push the dialog it opens onto the host. */
function openRemoveInputs(workspace: Workspace): void {
    const command = commands.find((c) => c.id === "analysis.remove-input");
    expect(command).toBeDefined();
    void command!.run({ ...workspace, openDialog: (render) => dialogPush(render) });
}

describe("the flat inputs list", () => {
    test("names each input by its absolute path, marking a directory", async () => {
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            openRemoveInputs(ws());
            const frame = await settle(setup);

            // The STORED path is anchor-relative ("counts.tsv"), which says nothing about where the
            // file is — two inputs from two anchors would render as the same string.
            expect(flat(frame)).toContain(join(anchorDir, "counts.tsv"));
            expect(flat(frame)).toContain(`${join(anchorDir, "data")}${sep}`);
            expect(frame).toContain("2.0 KB");
            expect(frame).toContain("directory");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an input outside the anchor folder is listed without any navigation", async () => {
        // The reason this surface exists at all: the picker seeds a far input into its selection but
        // renders no row for it until the user browses to that folder.
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            openRemoveInputs(ws());
            const frame = await settle(setup);
            expect(flat(frame)).toContain(join(outsideDir, "matrix.mtx"));
        } finally {
            setup.renderer.destroy();
        }
    });

    test("two inputs leave in one pass", async () => {
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            openRemoveInputs(ws());
            await settle(setup);

            // Multi mode: esc blurs the filter to NORMAL, then space toggles and enter confirms.
            setup.mockInput.pressEscape();
            await settle(setup);
            await setup.mockInput.pressKeys([" "]);
            setup.mockInput.pressArrow("down");
            await setup.mockInput.pressKeys([" "]);
            setup.mockInput.pressEnter();
            await settle(setup);

            expect(listAnalysisInputs(analysis.id)._unsafeUnwrap()).toHaveLength(1);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an input whose file is gone still lists and still removes", async () => {
        rmSync(join(outsideDir, "matrix.mtx"));
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            openRemoveInputs(ws());
            const frame = await settle(setup);
            // Removal resolves against the REGISTERED set, so a vanished file is a normal row.
            expect(flat(frame)).toContain(join(outsideDir, "matrix.mtx"));
            expect(frame).toContain("not on disk");

            // The far input sorts last (creation order), so walk to it and drop it.
            setup.mockInput.pressEscape();
            await settle(setup);
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            await setup.mockInput.pressKeys([" "]);
            setup.mockInput.pressEnter();
            await settle(setup);

            const left = listAnalysisInputs(analysis.id)._unsafeUnwrap();
            expect(left).toHaveLength(2);
            expect(left.some((i) => i.path.includes("matrix.mtx"))).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });
});
