import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";

import type { InputList, InputsChange, InputView } from "../api/analyses.ts";
import type { ClientOpts } from "../client/api.ts";
import { asStr256 } from "../lib/types.ts";
import { fakeClient, type FakeRequest } from "../test_support/fake_client.ts";
import { useKeymapRoot } from "./keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { openRemoveInputs } from "./commands.tsx";
import type { Analysis } from "../types/analysis.ts";

// The flat inputs list drives the REAL `analysis.remove-input` flow against a fake client of the server,
// which gives the inputs and records the removal. Two claims are under test and neither is visible from
// the picker: that a batch of inputs leaves in ONE request, and that a row names its input by a path the
// user can act on. The server's own removal is tested in `server/routes/analyses.test.ts`.

const analysis: Analysis = { id: "a1", createdAt: 0, updatedAt: 0, name: asStr256("rna-seq"), slug: "rna-seq", anchorId: "anchor-1", projectId: null };

let anchorDir = "";
let outsideDir = "";
let inputs: InputView[] = [];

beforeEach(() => {
    // realpath so the paths match the canonical form that the server gives, on macOS too.
    anchorDir = realpathSync(mkdtempSync(join(tmpdir(), "rm-inputs-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "rm-inputs-far-")));
    writeFileSync(join(anchorDir, "counts.tsv"), "x".repeat(2048));
    mkdirSync(join(anchorDir, "data"));
    writeFileSync(join(anchorDir, "data", "inner.txt"), "x");
    writeFileSync(join(outsideDir, "matrix.mtx"), "x");
    // The rows of `GET {A}/inputs`: two inputs under the anchor (stored relative), one outside it.
    inputs = [
        { path: "counts.tsv", isDir: false, anchorId: analysis.anchorId, absolutePath: join(anchorDir, "counts.tsv") },
        { path: "data", isDir: true, anchorId: analysis.anchorId, absolutePath: join(anchorDir, "data") },
        { path: join(outsideDir, "matrix.mtx"), isDir: false, anchorId: null, absolutePath: join(outsideDir, "matrix.mtx") },
    ];
});

afterEach(() => {
    dialogClear();
    for (const dir of [anchorDir, outsideDir]) rmSync(dir, { recursive: true, force: true });
});

/** The paths of a removal request. The cast reads the body that the flow under test built from `InputPathsRequest`. */
function pathsOf(req: FakeRequest | undefined): string[] {
    return (req?.body as { paths: string[] } | undefined)?.paths ?? [];
}

/** A fake server that lists `inputs` and removes the inputs at the paths of a removal. */
function server(): { opts: ClientOpts; removals: () => FakeRequest[] } {
    const client = fakeClient((req) => {
        if (req.method === "GET" && req.path.startsWith(`/api/v1/analyses/${analysis.id}/inputs`)) {
            const list: InputList = { inputs, total: inputs.length, page: 0, perPage: 200, hasMore: false };
            return { status: 200, body: list };
        }
        if (req.method === "POST" && req.path === `/api/v1/analyses/${analysis.id}/inputs/remove`) {
            const paths = pathsOf(req);
            const change: InputsChange = { added: [], removed: inputs.filter((i) => paths.includes(i.absolutePath ?? i.path)), notInputs: [] };
            return { status: 200, body: change };
        }
        return { status: 404, body: { error: "not_found", message: `No route for ${req.method} ${req.path}.` } };
    });
    return { opts: client.opts, removals: () => client.requests.filter((r) => r.path.endsWith("/inputs/remove")) };
}

function ws(): Workspace {
    return {
        analysis,
        sessionId: null,
        workingDir: anchorDir,
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

/** Run the real `analysis.remove-input` flow against the fake server and push the dialog it opens onto the host. */
async function openList(workspace: Workspace, opts: ClientOpts): Promise<void> {
    await openRemoveInputs({ ...workspace, openDialog: (render) => dialogPush(render) }, opts);
}

describe("the flat inputs list", () => {
    test("names each input by its absolute path, marking a directory", async () => {
        const s = server();
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            await openList(ws(), s.opts);
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
        const s = server();
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            await openList(ws(), s.opts);
            const frame = await settle(setup);
            expect(flat(frame)).toContain(join(outsideDir, "matrix.mtx"));
        } finally {
            setup.renderer.destroy();
        }
    });

    test("opens in NORMAL, so the first space toggles instead of typing", async () => {
        // The state a user actually meets. Mounting focused made space type a character into the
        // filter with nothing on screen explaining why the row would not select.
        const s = server();
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            await openList(ws(), s.opts);
            let frame = await settle(setup);
            expect(frame).toContain("NORMAL");

            await setup.mockInput.pressKeys([" "]);
            frame = await settle(setup);
            expect(frame).toContain("1 selected");

            // `i` returns to filtering, and the mode word follows.
            await setup.mockInput.pressKeys(["i"]);
            frame = await settle(setup);
            expect(frame).toContain("INSERT");
            await setup.mockInput.pressKeys([" "]);
            frame = await settle(setup);
            expect(frame).toContain("1 selected"); // the space typed, it did not toggle a second row
        } finally {
            setup.renderer.destroy();
        }
    });

    test("two inputs leave in one request", async () => {
        const s = server();
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            await openList(ws(), s.opts);
            await settle(setup);

            // Multi mode mounts in NORMAL (the FilePicker convention), so space toggles straight away.
            await setup.mockInput.pressKeys([" "]);
            setup.mockInput.pressArrow("down");
            await setup.mockInput.pressKeys([" "]);
            setup.mockInput.pressEnter();
            await settle(setup);

            expect(s.removals()).toHaveLength(1);
            expect(pathsOf(s.removals()[0])).toEqual([join(anchorDir, "counts.tsv"), join(anchorDir, "data")]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an input whose file is gone still lists and still removes", async () => {
        rmSync(join(outsideDir, "matrix.mtx"));
        const s = server();
        const setup = await testRender(harnessNode(ws()), { width: 120, height: 26 });
        try {
            await settle(setup);
            await openList(ws(), s.opts);
            const frame = await settle(setup);
            // Removal resolves against the REGISTERED set, so a vanished file is a normal row.
            expect(flat(frame)).toContain(join(outsideDir, "matrix.mtx"));
            expect(frame).toContain("not on disk");

            // The far input sorts last (the order of the list), so walk to it and drop it.
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            await setup.mockInput.pressKeys([" "]);
            setup.mockInput.pressEnter();
            await settle(setup);

            expect(pathsOf(s.removals()[0])).toEqual([join(outsideDir, "matrix.mtx")]);
        } finally {
            setup.renderer.destroy();
        }
    });
});
