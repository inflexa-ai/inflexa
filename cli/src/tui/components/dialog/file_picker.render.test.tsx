import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * The selection gutter of the row carrying `name`, or "" when no row does.
 *
 * Read positionally rather than by `toContain("● name")`: the row renders gutter, then the
 * permission column, then the name, so the glyph and the name are never adjacent in the frame.
 */
function gutterOf(frame: string, name: string): string {
    const line = frame.split("\n").find((l) => l.includes(name)) ?? "";
    const before = line.slice(0, line.indexOf(name));
    if (before.includes(GLYPHS.circle)) return GLYPHS.circle;
    if (before.includes(GLYPHS.circleHollow)) return GLYPHS.circleHollow;
    return "";
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
            expect(gutterOf(frame, "alpha.txt")).toBe(GLYPHS.circle);

            // Walk into beta and back: the toggle must survive both listings.
            setup.mockInput.pressArrow("up");
            setup.mockInput.pressEnter();
            frame = await settle(setup);
            expect(frame).toContain("inner.txt");
            expect(frame).toContain("1 selected");

            setup.mockInput.pressArrow("left");
            frame = await settle(setup);
            expect(gutterOf(frame, "alpha.txt")).toBe(GLYPHS.circle);
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
            expect(gutterOf(frame, "alpha.txt")).toBe(GLYPHS.circleHollow); // removed in review → unchecked here
        } finally {
            setup.renderer.destroy();
        }
    });

    test("c confirms the batch even when the cursor sits on a directory row", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const confirmed: string[][] = [];
        try {
            await settle(setup);
            await openPicker(setup, { onConfirm: (p) => confirmed.push(p) });
            setup.mockInput.pressArrow("down"); // .. → beta/ (a directory row: enter would descend)
            setup.mockInput.pressKey(" ");
            let frame = await settle(setup);
            expect(frame).toContain("1 selected");

            setup.mockInput.pressKey("c");
            frame = await settle(setup);
            expect(confirmed).toEqual([[join(root, "beta")]]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("enter confirms the accumulated batch when a filter matches nothing", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const confirmed: string[][] = [];
        try {
            await settle(setup);
            await openPicker(setup, { onConfirm: (p) => confirmed.push(p) });
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down"); // beta/ → alpha.txt
            setup.mockInput.pressKey(" ");
            await settle(setup);

            setup.mockInput.pressKey("i");
            await setup.mockInput.typeText("zzz"); // no rows survive; the batch must still confirm
            let frame = await settle(setup);
            expect(frame).toContain("No matches");

            setup.mockInput.pressEnter();
            frame = await settle(setup);
            expect(confirmed).toEqual([[join(root, "alpha.txt")]]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a symlink row keys on its canonical target, so a canonical seed renders it checked", async () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-picker-ext-")));
        writeFileSync(join(outside, "payload.txt"), "x");
        symlinkSync(outside, join(root, "ext"));
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            // The seed is what classifyInputPath records: the symlink's canonical TARGET.
            const frame = await openPicker(setup, { seed: [outside] });
            expect(gutterOf(frame, "ext/")).toBe(GLYPHS.circle);
            expect(frame).toContain("1 selected");
        } finally {
            setup.renderer.destroy();
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test(".. renders no selection gutter even when the parent dir is selected", async () => {
        mkdirSync(join(root, "beta", "ml"));
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            await openPicker(setup);
            setup.mockInput.pressArrow("down"); // beta/
            setup.mockInput.pressKey(" "); // select beta
            setup.mockInput.pressEnter(); // descend into beta
            let frame = await settle(setup);
            expect(frame).toContain("1 selected");

            setup.mockInput.pressArrow("down"); // .. → ml/
            setup.mockInput.pressEnter(); // descend into beta/ml — `..` now points at selected beta
            frame = await settle(setup);
            expect(frame).toContain("..");
            expect(frame).toContain("1 selected");
            // Navigation-only row: neither checked nor uncheckable-looking.
            expect(gutterOf(frame, "..")).not.toBe(GLYPHS.circle);
            expect(gutterOf(frame, "..")).not.toBe(GLYPHS.circleHollow);
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

describe("FilePicker entry metadata", () => {
    /** The row line carrying `needle`, or "" — the hint rides the SAME line as the title. */
    function rowLine(frame: string, needle: string): string {
        return frame.split("\n").find((l) => l.includes(needle)) ?? "";
    }

    test("a file row carries its permissions, its size, and an absolute date", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        writeFileSync(join(root, "sized.txt"), "x".repeat(2048));
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            const line = rowLine(frame, "sized.txt");
            // The mode sits LEFT of the name, as `ls -l` puts it.
            expect(line.slice(0, line.indexOf("sized.txt"))).toMatch(/[r-][w-][x-][r-][w-][x-][r-][w-][x-]/);
            expect(line).toContain("2.0 KB");
            // Absolute local time, never a relative age — a record listing reads on the absolute side.
            expect(line).toMatch(/\d{2}\/\d{2}\/\d{2}/);
            expect(line).not.toMatch(/\b\d+[dhm]\b/);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the size and date land in aligned columns across rows", async () => {
        // The whole point of the facts: comparing them down a column. Ragged fields defeat it, and
        // the two causes are independent — an unpadded size, and a date whose parts are not zero-padded.
        const setup = await testRender(() => <Harness />, { width: 100, height: 26 });
        writeFileSync(join(root, "small.txt"), "x".repeat(600));
        writeFileSync(join(root, "large.txt"), "x".repeat(140_000));
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            const small = rowLine(frame, "small.txt");
            const large = rowLine(frame, "large.txt");
            // Sizes of different widths ("600 B" vs "136.7 KB") end at the same column.
            expect(small.indexOf(GLYPHS.middot)).toBe(large.indexOf(GLYPHS.middot));
            // And the dates start together, which only holds while every part is zero-padded.
            const dateAt = (l: string): number => l.search(/\d{2}\/\d{2}\/\d{2}/);
            expect(dateAt(small)).toBe(dateAt(large));
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a directory keeps the date column despite carrying no size", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 26 });
        writeFileSync(join(root, "sized.txt"), "x".repeat(2048));
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            const dateAt = (l: string): number => l.search(/\d{2}\/\d{2}\/\d{2}/);
            // The blank size field spans its separator too, or the dir's date would slide left.
            expect(dateAt(rowLine(frame, "beta/"))).toBe(dateAt(rowLine(frame, "sized.txt")));
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a directory row carries a date but no size", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            const line = rowLine(frame, "beta/");
            expect(line).toMatch(/\d{2}\/\d{2}\/\d{2}/);
            // Counting members would cost a readdir per row — the budget this listing protects.
            expect(line).not.toMatch(/\d+(\.\d+)?\s?(B|KB|MB|GB)/);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an unreadable file paints its row in the theme's warning color", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const denied = join(root, "denied.txt");
        writeFileSync(denied, "x");
        chmodSync(denied, 0o000);
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            expect(frame).toContain("denied.txt");
            // A char frame carries no color, so containment alone would pass on an unpainted row:
            // the claim here is that the row LOOKS different, which only a resolved span proves.
            const spans = setup.captureSpans().lines.flatMap((l) => l.spans);
            const deniedFg = spans.find((s) => s.text.includes("denied.txt"))?.fg;
            const readableFg = spans.find((s) => s.text.includes("zeta.txt"))?.fg;
            expect(deniedFg).toBeDefined();
            expect(readableFg).toBeDefined();
            expect(deniedFg).not.toEqual(readableFg);
        } finally {
            chmodSync(denied, 0o644);
            setup.renderer.destroy();
        }
    });

    test("an unreadable file is still selectable — the mark warns, it does not refuse", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const denied = join(root, "denied.txt");
        writeFileSync(denied, "x");
        chmodSync(denied, 0o000);
        let confirmed: string[] = [];
        try {
            await settle(setup);
            // dirs first, then files alphabetically: .. → beta/ → alpha.txt → denied.txt
            await openPicker(setup, { onConfirm: (paths) => (confirmed = paths) });
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            await setup.mockInput.pressKeys([" "]);
            await setup.mockInput.pressKeys(["c"]);
            await settle(setup);
            expect(confirmed).toEqual([denied]);
        } finally {
            chmodSync(denied, 0o644);
            setup.renderer.destroy();
        }
    });

    test("a broken symlink lists with no metadata rather than dropping out", async () => {
        // The deterministic stand-in for a stat that loses its race with a deletion: statSync
        // follows the link and throws, which is exactly the path `entryMeta` degrades on.
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        symlinkSync(join(root, "gone.txt"), join(root, "dangling.txt"));
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            const line = rowLine(frame, "dangling.txt");
            expect(line).not.toBe("");
            expect(line.slice(0, line.indexOf("dangling.txt"))).not.toMatch(/[r-][w-][x-][r-][w-][x-][r-][w-][x-]/);
            // And it holds the column as blanks: a name that starts where the mode starts reads as a
            // mode string, and it breaks the alignment every other row of the listing depends on.
            expect(line.indexOf("dangling.txt")).toBe(rowLine(frame, "alpha.txt").indexOf("alpha.txt"));
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a listing whose every stat fails is not reported as a large folder", async () => {
        // The footer states a CAUSE. Inferring "no row has metadata" from the rows cannot tell the
        // ceiling from a folder holding one broken symlink, and it names the wrong one.
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const onlyBroken = join(root, "broken");
        mkdirSync(onlyBroken);
        symlinkSync(join(onlyBroken, "gone.txt"), join(onlyBroken, "dangling.txt"));
        try {
            await settle(setup);
            await openPicker(setup);
            // dirs sort first, alphabetically: .. → beta/ → broken/
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressEnter();
            const frame = await settle(setup);
            expect(frame).toContain("dangling.txt");
            expect(frame).not.toContain("details off (large folder)");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a folder over the ceiling lists names only and says so in the footer", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        const big = join(root, "big");
        mkdirSync(big);
        for (let i = 0; i < 2001; i++) writeFileSync(join(big, `f${i}.txt`), "x");
        try {
            await settle(setup);
            await openPicker(setup);
            // dirs sort first, alphabetically: .. → beta/ → big/
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressArrow("down");
            setup.mockInput.pressEnter();
            const frame = await settle(setup);
            expect(frame).toContain("details off (large folder)");
            const line = rowLine(frame, "f0.txt");
            expect(line.slice(0, line.indexOf("f0.txt"))).not.toMatch(/[r-][w-][x-][r-][w-][x-][r-][w-][x-]/);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the listing sets no description, so no detail line grows under it", async () => {
        const setup = await testRender(() => <Harness />, { width: 90, height: 26 });
        try {
            await settle(setup);
            const frame = await openPicker(setup);
            // The detail line would repeat the cursor row's path on its own row beneath the list.
            const pathLines = frame.split("\n").filter((l) => l.includes(root));
            expect(pathLines).toHaveLength(0);
        } finally {
            setup.renderer.destroy();
        }
    });
});
