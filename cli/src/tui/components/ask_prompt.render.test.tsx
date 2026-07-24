import { describe, expect, test } from "bun:test";
import { Show } from "solid-js";
import { testRender } from "@opentui/solid";
import type { BoxRenderable, Renderable, TextareaRenderable } from "@opentui/core";

import { AskPrompt } from "./ask_prompt.tsx";
import { GLYPHS, size, space } from "../../lib/design_system.ts";
import { useKeymapRoot } from "../keymap.ts";
import { renderFrame } from "../../test_support/tui.ts";

// Two proofs live here. The static frames (width sweep + short height) show that the docked prompt
// paints its title, exact command, detail, key hints, and the queued-count hint at every terminal
// width. The interactive tests drive the REAL keyboard bus through useKeymapRoot to prove the
// focus-target gate: the prompt's bare y/a/n keys are legal ONLY while it holds focus, and never
// steal characters from a co-mounted, focused editor (the bare-printable rule).
//
// The frames additionally pin the marker-gutter LAYOUT: the caution glyph occupies the shared fixed
// gutter column on the title row and every other row hangs at that indent, in both modes. Character
// frames are the right instrument for exactly this and nothing more — they carry no color, so they
// prove a glyph landed in a column, never that it is legible. Contrast is measured separately, on
// resolved span colors, in theme_contrast.render.test.tsx.

/** The column every non-marker row starts at: the panel's own padding plus the marker gutter. */
const gutterIndent = " ".repeat(space.sm + size.gutter);

/** The title row: padding, the caution glyph alone in the gutter column, then the title at the indent. */
function markerRow(title: string): string {
    return `${" ".repeat(space.sm)}${GLYPHS.warning} ${title}`;
}

/**
 * True when a row's content begins EXACTLY at the gutter indent. The negative half is what gives the
 * check teeth: `startsWith` alone also passes a row indented one cell too far.
 */
function hangsAtGutter(line: string): boolean {
    return line.startsWith(gutterIndent) && !line.startsWith(`${gutterIndent} `);
}

// A lone ESC byte is an ambiguous escape-sequence prefix that opentui's StdinParser holds for ~20ms
// before flushing as a standalone key, so key-driven steps settle on a real clock (matches the
// dialog/scroll render tests). Harmless for single printable keys, so it is used uniformly.
function makeSettle(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
    return async () => {
        await new Promise((r) => setTimeout(r, 35));
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

/** Mounts the prompt under a keymap root, optionally beside a focus-grabbing editor (the leak test). */
function Harness(props: {
    withEditor?: boolean;
    busy?: boolean;
    inert?: boolean;
    onBox?: (r: BoxRenderable) => void;
    onTa?: (r: TextareaRenderable) => void;
    onApprove?: (kind: "once" | "always") => void;
    onReject?: (feedback?: string) => void;
}) {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            <Show when={props.withEditor}>
                <textarea
                    ref={(r: TextareaRenderable) => {
                        queueMicrotask(() => r.focus());
                        props.onTa?.(r);
                    }}
                />
            </Show>
            <AskPrompt
                title="Run shell command"
                command="rm -rf build"
                queuedCount={0}
                busy={props.busy}
                inert={props.inert}
                onApprove={(kind) => props.onApprove?.(kind)}
                onReject={(feedback) => props.onReject?.(feedback)}
                onFocusReady={(r) => props.onBox?.(r)}
            />
        </box>
    );
}

describe("AskPrompt choice-mode frame", () => {
    for (const width of [80, 100, 120]) {
        test(`renders title, command, detail, hints, and the queued-count hint at width ${width}`, async () => {
            const frame = await renderFrame(
                () => (
                    <AskPrompt
                        title="Run shell command"
                        command="rm -rf build"
                        detail="Deletes the build directory"
                        queuedCount={2}
                        onApprove={() => {}}
                        onReject={() => {}}
                    />
                ),
                { width, height: 10 },
            );
            expect(frame).toContain("Run shell command");
            expect(frame).toContain("rm -rf build");
            expect(frame).toContain("Deletes the build directory");
            // The hint line reads "y approve · a always · n reject" — assert its words survive the split spans.
            expect(frame).toContain("approve");
            expect(frame).toContain("always");
            expect(frame).toContain("reject");
            expect(frame).toContain("+2 more");

            // Alignment is asserted inside the sweep because it is width-independent by construction:
            // the gutter is a fixed column and only the content column absorbs the squeeze.
            const lines = frame.split("\n");
            expect(lines[0]).toBe(markerRow("Run shell command"));
            expect(lines[1]).toBe(`${gutterIndent}rm -rf build`);
            expect(lines[2]).toBe(`${gutterIndent}Deletes the build directory`);
            expect(lines[3]).toBe(`${gutterIndent}y approve ${GLYPHS.middot} a always ${GLYPHS.middot} n reject  +2 more`);
            // The glyph marks the block once, from the gutter — it is not repeated down the rows.
            expect(frame.split(GLYPHS.warning).length - 1).toBe(1);
        });
    }

    test("stays legible on a short terminal (no detail, no queue)", async () => {
        const frame = await renderFrame(
            () => <AskPrompt title="Run shell command" command="rm -rf build" queuedCount={0} onApprove={() => {}} onReject={() => {}} />,
            {
                width: 80,
                height: 6,
            },
        );
        expect(frame).toContain("Run shell command");
        expect(frame).toContain("rm -rf build");
        expect(frame).toContain("approve");
        // No queue → no +N hint.
        expect(frame).not.toContain("more");

        // A block with no detail row still hangs off the gutter — the indent is structural, not a
        // side effect of the optional rows being present.
        const lines = frame.split("\n");
        expect(lines[0]).toBe(markerRow("Run shell command"));
        expect(lines[1]).toBe(`${gutterIndent}rm -rf build`);
        expect(lines[2]).toBe(`${gutterIndent}y approve ${GLYPHS.middot} a always ${GLYPHS.middot} n reject`);
    });
});

describe("AskPrompt feedback mode", () => {
    test("pressing n reveals the feedback input", async () => {
        let box: BoxRenderable | null = null;
        const setup = await testRender(() => <Harness onBox={(r) => (box = r)} />, { width: 80, height: 12 });
        const settle = makeSettle(setup);
        const frame = () =>
            setup
                .captureCharFrame()
                .split("\n")
                .map((l) => l.trimEnd())
                .join("\n");
        try {
            await settle();
            // Focus the prompt (the host's job in production) so its choice keys are live.
            box!.focus();
            await settle();
            expect(frame()).toContain("n reject");
            expect(frame().split("\n")[0]).toBe(markerRow("Run shell command"));

            setup.mockInput.pressKey("n");
            await settle();
            // The feedback surface: the input's placeholder and the submit/back hint replace the choices.
            expect(frame()).toContain("feedback");
            expect(frame()).toContain("esc back");
            expect(frame()).not.toContain("n reject");

            // The gutter lives outside the mode switch, so the toggle must not shift the block: the
            // marker holds the same column and the feedback rows hang at the same indent as the
            // choice rows did. This is the whole reason the glyph is not inside the <Show>.
            const after = frame().split("\n");
            expect(after[0]).toBe(markerRow(`Reject ${GLYPHS.emDash} add feedback (optional)`));
            // Naming the offending rows beats a bare boolean: a failure has to say which line drifted.
            expect(after.slice(1, 5).filter((l) => l.length > 0 && !hangsAtGutter(l))).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("initialMode feedback seeds the input surface with no key press", async () => {
        // The gallery-exhibit path: the feedback surface renders from the seed alone (inert = the
        // embedded input mounts blurred), so no host focus or keypress is needed to show it.
        const frame = await renderFrame(
            () => (
                <AskPrompt
                    title="Run shell command"
                    command="rm -rf build"
                    queuedCount={0}
                    initialMode="feedback"
                    inert
                    onApprove={() => {}}
                    onReject={() => {}}
                />
            ),
            { width: 80, height: 8 },
        );
        expect(frame).toContain("feedback");
        expect(frame).toContain("esc back");
        expect(frame).not.toContain("n reject");

        // The seeded surface hangs off the same gutter as the key-driven one — the marker is shared
        // structure, not something the `n` transition installs.
        const lines = frame.split("\n");
        expect(lines[0]).toBe(markerRow(`Reject ${GLYPHS.emDash} add feedback (optional)`));
        expect(lines.slice(1).filter((l) => l.length > 0 && !hangsAtGutter(l))).toEqual([]);
    });
});

describe("AskPrompt mouse activation", () => {
    // Locate a choice option on the rendered hint row by a word unique to it and return a cell inside its
    // clickable <text>. The word ("approve"/"always"/"reject") sits in that option's segment, so a click
    // there lands on the option renderable — not the middot separators between them. Clicking without any
    // prior box.focus() is the whole point: mouse activation must NOT depend on the focus-target gate that
    // the bare keys require.
    function optionCell(setup: Awaited<ReturnType<typeof testRender>>, needle: string): { x: number; y: number } {
        const lines = setup.captureCharFrame().split("\n");
        const y = lines.findIndex((l) => l.includes(needle));
        expect(y).toBeGreaterThanOrEqual(0);
        return { x: lines[y]!.indexOf(needle), y };
    }

    test("clicking each option runs its handler with no prior focus; n enters feedback like the key", async () => {
        const approvals: Array<"once" | "always"> = [];
        let rejected = 0;
        const setup = await testRender(() => <Harness onApprove={(k) => approvals.push(k)} onReject={() => rejected++} />, { width: 80, height: 10 });
        try {
            await setup.renderOnce();

            const yCell = optionCell(setup, "approve");
            await setup.mockMouse.click(yCell.x, yCell.y);
            await setup.renderOnce();
            expect(approvals).toEqual(["once"]);

            const aCell = optionCell(setup, "always");
            await setup.mockMouse.click(aCell.x, aCell.y);
            await setup.renderOnce();
            expect(approvals).toEqual(["once", "always"]);

            // A click on `n reject` enters feedback mode exactly as the key does — it is NOT an onReject call.
            const nCell = optionCell(setup, "reject");
            await setup.mockMouse.click(nCell.x, nCell.y);
            await setup.renderOnce();
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("esc back");
            expect(rejected).toBe(0);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a selection drag released over an option does not activate it", async () => {
        const approvals: Array<"once" | "always"> = [];
        let rejected = 0;
        const setup = await testRender(() => <Harness onApprove={(k) => approvals.push(k)} onReject={() => rejected++} />, { width: 80, height: 10 });
        try {
            await setup.renderOnce();
            const lines = setup.captureCharFrame().split("\n");
            // Drag STARTS on the selectable command text and RELEASES on the y approve option: the release
            // fires the option's mouse-up, but a live selection exists, so the guard treats it as the tail
            // of the selection gesture — not a click.
            const cmdY = lines.findIndex((l) => l.includes("rm -rf build"));
            const optY = lines.findIndex((l) => l.includes("approve"));
            await setup.mockMouse.drag(lines[cmdY]!.indexOf("rm -rf build"), cmdY, lines[optY]!.indexOf("approve"), optY);
            await setup.renderOnce();

            expect(setup.renderer.getSelection()?.getSelectedText() ?? "").not.toBe("");
            expect(approvals).toEqual([]);
            expect(rejected).toBe(0);
            // And it did not flip to feedback mode either (the drag ended on approve, but a drag onto reject
            // would be guarded identically).
            expect(setup.captureCharFrame()).not.toContain("esc back");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("clicks are inert while busy — the same gate the keys inherit", async () => {
        const approvals: Array<"once" | "always"> = [];
        const setup = await testRender(() => <Harness busy onApprove={(k) => approvals.push(k)} onReject={() => {}} />, { width: 80, height: 10 });
        try {
            await setup.renderOnce();
            const cell = optionCell(setup, "approve");
            await setup.mockMouse.click(cell.x, cell.y);
            await setup.renderOnce();
            expect(approvals).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("clicks are inert when inert is set — no answer, no mode flip", async () => {
        const approvals: Array<"once" | "always"> = [];
        let rejected = 0;
        let box: BoxRenderable | null = null;
        const setup = await testRender(() => <Harness inert onBox={(r) => (box = r)} onApprove={(k) => approvals.push(k)} onReject={() => rejected++} />, {
            width: 80,
            height: 10,
        });
        try {
            await setup.renderOnce();

            // Focus hardening: an inert exhibit's box is non-focusable, so opentui's mousedown-autofocus
            // walk finds no focusable ancestor and cannot yank focus off the gallery pane.
            expect(box!.focusable).toBe(false);

            const yCell = optionCell(setup, "approve");
            await setup.mockMouse.click(yCell.x, yCell.y);
            await setup.renderOnce();
            expect(approvals).toEqual([]);

            // The exhibit-inertness scenario: clicking `n reject` must NOT flip the exhibit into feedback
            // mode (which would mount an auto-focusing input and steal the pane's focus).
            const nCell = optionCell(setup, "reject");
            await setup.mockMouse.click(nCell.x, nCell.y);
            await setup.renderOnce();
            await setup.renderOnce();
            expect(setup.captureCharFrame()).not.toContain("esc back");
            expect(rejected).toBe(0);
        } finally {
            setup.renderer.destroy();
        }
    });

    // Frames carry no selectability: captureCharFrame proves a glyph landed in a column, never that the
    // <text> beneath it opted out of selection. So the spec clause "The option texts SHALL be excluded from
    // text selection" (tui-ask-approval) is unpinnable from any character frame — it lives solely on each
    // option renderable's `selectable` flag (opentui's TextBufferRenderable.selectable, default true). Assert
    // it structurally on the renderable tree, with the command prose as a positive control so a read that is
    // vacuously false for every renderable cannot pass this test.
    test("the three option buttons are excluded from selection while the command prose stays selectable", async () => {
        const setup = await testRender(() => <Harness onApprove={() => {}} onReject={() => {}} />, { width: 80, height: 10 });
        try {
            await setup.renderOnce();

            // Walk the renderable tree from the root — the same getChildren() recursion app.tsx's
            // applySelectionColors uses. A <text> exposes `plainText` (its concatenated visible text) and the
            // `selectable` flag; a <box> exposes neither, so `"plainText" in r` selects exactly the text nodes
            // and makes the read of those two members sound.
            type SelectableText = { plainText: string; selectable: boolean };
            const texts: SelectableText[] = [];
            const collect = (r: Renderable): void => {
                if ("plainText" in r) texts.push(r as unknown as SelectableText);
                for (const child of r.getChildren()) collect(child);
            };
            collect(setup.renderer.root);

            // Each option is its own <text>; match on the word unique to that segment ("y approve", etc.).
            const selectableOf = (needle: string): boolean => {
                const hit = texts.find((t) => t.plainText.includes(needle));
                expect(hit).toBeDefined();
                // Non-null: toBeDefined above throws when the row is absent, so hit is set on this line.
                return hit!.selectable;
            };

            expect(selectableOf("approve")).toBe(false);
            expect(selectableOf("always")).toBe(false);
            expect(selectableOf("reject")).toBe(false);
            // Positive control: ordinary prose keeps selection on, proving the reads above read a real flag
            // rather than reporting false for every renderable regardless.
            expect(selectableOf("rm -rf build")).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("AskPrompt key gating (bare-printable rule)", () => {
    test("unfocused prompt keys go to the editor; focused prompt keys fire onApprove", async () => {
        let box: BoxRenderable | null = null;
        let ta: TextareaRenderable | null = null;
        const approvals: Array<"once" | "always"> = [];
        const setup = await testRender(() => <Harness withEditor onBox={(r) => (box = r)} onTa={(r) => (ta = r)} onApprove={(k) => approvals.push(k)} />, {
            width: 80,
            height: 12,
        });
        const settle = makeSettle(setup);
        try {
            await settle();
            // The editor grabbed focus on mount; the prompt is mounted but unfocused.
            expect(ta!.focused).toBe(true);
            // Positive control for the inert-gating of focusability: a live (non-inert) prompt's box IS
            // focusable, which is what lets the host focus it to engage the bare-key layer below.
            expect(box!.focusable).toBe(true);

            // With the editor focused, y is NOT a prompt key — it types into the editor and never approves.
            setup.mockInput.pressKey("y");
            await settle();
            expect(ta!.editBuffer.getText()).toBe("y");
            expect(approvals).toEqual([]);

            // Focus the prompt: now the same y is captured by the target-gated layer and approves once.
            box!.focus();
            await settle();
            setup.mockInput.pressKey("y");
            await settle();
            expect(approvals).toEqual(["once"]);
            // The editor is blurred and the key was swallowed by the binding — its buffer is untouched.
            expect(ta!.editBuffer.getText()).toBe("y");
        } finally {
            setup.renderer.destroy();
        }
    });
});
