import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";

import { useKeymapRoot } from "../../keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./dialog_host.tsx";
import { FilePicker } from "./file_picker.tsx";
import { GLYPHS } from "../../../lib/design_system.ts";

// FilePicker behavior through the real dialog host + keyboard bus: the INSERT/NORMAL esc
// layering runs on the close-guard veto, which only exists inside a real dialog entry — so
// every test pushes the picker through dialogPush under a DialogOverlay harness.

let root = "";

beforeEach(() => {
    // realpath so path assertions match the picker's canonical value space (macOS /var → /private/var).
    root = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-picker-")));
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "beta", "inner.txt"), "x");
    writeFileSync(join(root, "alpha.txt"), "x");
    writeFileSync(join(root, "zeta.txt"), "x");
    writeFileSync(join(root, ".hidden.txt"), "x");
});

afterEach(() => {
    dialogClear();
    rmSync(root, { recursive: true, force: true });
});

function Harness(): JSX.Element {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            <DialogOverlay />
        </box>
    );
}

type Setup = Awaited<ReturnType<typeof testRender>>;

// A lone ESC byte is an ambiguous escape-sequence prefix: opentui's StdinParser holds it ~20ms
// before flushing, so settle on a real clock (the dialog_host test's pattern).
async function settle(setup: Setup): Promise<string> {
    await new Promise((r) => setTimeout(r, 35));
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

async function openPicker(
    setup: Setup,
    opts: { seed?: string[]; requireSelection?: boolean; onConfirm?: (paths: string[]) => void; onCancel?: () => void } = {},
): Promise<string> {
    dialogPush(() => (
        <FilePicker
            rootPath={root}
            selectedPaths={new Set(opts.seed ?? [])}
            confirmLabel="Add"
            requireSelection={opts.requireSelection}
            onConfirm={opts.onConfirm ?? (() => {})}
            onCancel={opts.onCancel ?? (() => {})}
        />
    ));
    return settle(setup);
}

describe("FilePicker", () => {
    test("lists dirs first with a trailing slash, hides dotfiles, prepends ..", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            expect(frame).toContain("..");
            expect(frame).toContain("beta/");
            expect(frame).toContain("alpha.txt");
            expect(frame).not.toContain(".hidden.txt");
            expect(frame.indexOf("beta/")).toBeLessThan(frame.indexOf("alpha.txt")); // dirs first
            expect(frame).toContain("NORMAL"); // mounts in NORMAL mode
        } finally {
            setup.renderer.destroy();
        }
    });

    test("enter descends into a dir and resets the filter; left ascends", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            await openPicker(setup);
            setup.mockInput.pressArrow("down"); // .. → beta/
            setup.mockInput.pressEnter();
            let frame = await settle(setup);
            expect(frame).toContain("inner.txt");
            expect(frame).not.toContain("alpha.txt");

            setup.mockInput.pressArrow("left");
            frame = await settle(setup);
            expect(frame).toContain("alpha.txt");
        } finally {
            setup.renderer.destroy();
        }
    });

    test(".. is never toggleable; space toggles real rows and survives navigation", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            await openPicker(setup);
            setup.mockInput.pressKey(" "); // cursor starts on .. — must refuse
            let frame = await settle(setup);
            expect(frame).toContain("none selected");

            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down"); // beta/ → alpha.txt
            setup.mockInput.pressKey(" ");
            frame = await settle(setup);
            expect(frame).toContain("1 selected");
            expect(frame).toContain(`${GLYPHS.circle} alpha.txt`);

            // Walk into beta and back: the toggle must survive both listings.
            setup.mockInput.pressArrow("up");
            setup.mockInput.pressEnter();
            frame = await settle(setup);
            expect(frame).toContain("inner.txt");
            expect(frame).toContain("1 selected");

            setup.mockInput.pressArrow("left");
            frame = await settle(setup);
            expect(frame).toContain(`${GLYPHS.circle} alpha.txt`);
            expect(frame).toContain("1 selected");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("INSERT vs NORMAL: i focuses the filter, space types there, esc blurs, then space toggles", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            await openPicker(setup);
            setup.mockInput.pressKey("i");
            let frame = await settle(setup);
            expect(frame).toContain("INSERT");

            await setup.mockInput.typeText("alp");
            frame = await settle(setup);
            expect(frame).toContain("alpha.txt");
            expect(frame).not.toContain("zeta.txt");
            expect(frame).not.toContain(".."); // filter active → .. hidden

            setup.mockInput.pressKey(" "); // INSERT: space types, no toggle
            frame = await settle(setup);
            expect(frame).toContain("none selected");

            setup.mockInput.pressEscape(); // first esc: blur → NORMAL (picker stays open)
            frame = await settle(setup);
            expect(frame).toContain("NORMAL");
            expect(frame).toContain("Select input files");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("esc in NORMAL cancels; requireSelection refuses an empty confirm", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const confirmed: string[][] = [];
        let cancelled = 0;
        try {
            await settle(setup);
            await openPicker(setup, {
                requireSelection: true,
                onConfirm: (p) => confirmed.push(p),
                onCancel: () => cancelled++,
            });
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down"); // alpha.txt (a file row)
            setup.mockInput.pressEnter(); // confirm with empty selection — refused
            let frame = await settle(setup);
            expect(confirmed.length).toBe(0);
            expect(frame).toContain("Select input files"); // still open

            setup.mockInput.pressKey(" ");
            setup.mockInput.pressEnter();
            await settle(setup);
            expect(confirmed.length).toBe(1);
            expect(confirmed[0]).toEqual([join(root, "alpha.txt")]);

            setup.mockInput.pressEscape(); // NORMAL esc → cancel through the funnel
            frame = await settle(setup);
            expect(cancelled).toBe(1);
            expect(frame).not.toContain("Select input files");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("review mode lists root-relative selections; enter removes; esc returns to browsing", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            await openPicker(setup, { seed: [join(root, "alpha.txt"), join(root, "beta", "inner.txt")] });
            let frame = await settle(setup);
            expect(frame).toContain("2 selected");

            setup.mockInput.pressKey("s");
            frame = await settle(setup);
            expect(frame).toContain("REVIEW");
            expect(frame).toContain("beta/inner.txt"); // root-relative title
            expect(frame).toContain("alpha.txt");

            setup.mockInput.pressEnter(); // remove the first (sorted: alpha.txt)
            frame = await settle(setup);
            expect(frame).toContain("1 selected");

            setup.mockInput.pressEscape(); // back to browsing, selection intact
            frame = await settle(setup);
            expect(frame).toContain("NORMAL");
            expect(frame).toContain("1 selected");
            expect(frame).toContain(`${GLYPHS.circleHollow} alpha.txt`); // removed in review → unchecked here
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an unreadable directory degrades to the error line and left still ascends", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            await settle(setup);
            await openPicker(setup);
            // dirs sort first: .. → beta/ → locked/
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressEnter();
            let frame = await settle(setup);
            expect(frame.toLowerCase()).toContain("permission denied");

            setup.mockInput.pressArrow("left");
            frame = await settle(setup);
            expect(frame).toContain("alpha.txt");
        } finally {
            chmodSync(locked, 0o755);
            setup.renderer.destroy();
        }
    });
});
