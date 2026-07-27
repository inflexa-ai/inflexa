import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { testRender, useRenderer } from "@opentui/solid";

import { forceFullRepaint, watchScreenDamage, REPAINT_IDLE_GAP_MS } from "./hooks/repaint.ts";
import { useKeymapRoot, useBindings, resolveKeybind, pushMode, MODE_BASE, MODE_MODAL, __resetKeybindCache } from "./keymap.ts";

// Guards the screen-damage recovery against a silent regression. The whole fix rests on ONE private
// @opentui/core field (`forceFullRepaintRequested` — see hooks/repaint.ts for why no public
// equivalent exists), so an upgrade that renames or removes it would turn forceFullRepaint into a
// no-op that typechecks, lints, and renders identically. These tests run against a REAL renderer, so
// that upgrade fails here instead of shipping a chat that stays blank after Terminal.app's ⌘K.

/** Read the private flag off a real renderer — the exact field hooks/repaint.ts writes. */
function repaintFlag(renderer: object): unknown {
    return (renderer as { forceFullRepaintRequested?: unknown }).forceFullRepaintRequested;
}

function Empty() {
    return <box width="100%" height="100%" />;
}

afterEach(() => {
    __resetKeybindCache();
});

/**
 * Mirrors app.tsx's redraw wiring: the single keymap root plus the MODELESS redraw layer. A modeless
 * layer is the load-bearing choice under test — a redraw key that a modal suspends is useless exactly
 * when a modal is the thing that got wiped. (Mounting the real App needs the whole
 * workspace/DB/conversation stack; tsc covers that wiring, as in keymap_scroll.render.test.tsx.)
 */
function RedrawHarness() {
    const renderer = useRenderer();
    useKeymapRoot();
    useBindings(() => ({
        bindings: [{ chord: resolveKeybind("app.redraw"), run: () => forceFullRepaint(renderer) }],
    }));
    // A base-mode layer that MODE_MODAL suspends, so the modal case below proves the redraw layer's
    // modelessness rather than merely that the engine still dispatches at all.
    useBindings(() => ({ mode: MODE_BASE, bindings: [{ chord: { key: "z" }, run: () => baseModeHits++ }] }));
    return <box width="100%" height="100%" />;
}

let baseModeHits = 0;

/**
 * A TTY-shaped stdout that keeps what the renderer writes. `testRender`'s own stdout throws every
 * chunk away and defaults `bufferedOutput` to `"memory"`, so asserting on emitted BYTES needs both an
 * explicit `bufferedOutput: "stdout"` and a stream like this.
 */
class CapturingStdout extends Writable {
    readonly isTTY = true;
    readonly columns = 60;
    readonly rows = 10;
    private chunks: Buffer[] = [];
    override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
    }
    getColorDepth(): number {
        return 24;
    }
    /** Everything written since the last take. */
    take(): string {
        const s = Buffer.concat(this.chunks).toString("utf8");
        this.chunks = [];
        return s;
    }
}

const WIRE_MARKER = "UNIQUE-WIRE-MARKER";

function Marked() {
    return (
        <box width="100%" height="100%">
            <text fg="#c0caf5">{WIRE_MARKER}</text>
        </box>
    );
}

describe("forceFullRepaint at the wire", () => {
    // The strongest of these guards: it asserts the private field actually CAUSES a full repaint in the
    // emitted byte stream, not merely that the renderer accepted and cleared it. A version of opentui
    // that kept the field but stopped honouring it would pass every in-memory check and still ship a
    // chat that never recovers — only this test would catch that.
    test("a plain re-render emits nothing; a forced one re-emits the whole frame", async () => {
        const capture = new CapturingStdout();
        // Sound: opentui only ever uses the TTY surface of stdout (isTTY/columns/rows/getColorDepth
        // plus writes), all of which CapturingStdout provides; the WriteStream type is far wider than
        // what it touches, and testRender's own createTestStdout is cast the same way.
        const stdout = capture as unknown as NodeJS.WriteStream;
        const setup = await testRender(() => <Marked />, {
            width: 60,
            height: 10,
            stdout,
            bufferedOutput: "stdout",
            // Match production (app.launch.tsx); testRender would otherwise default to main-screen.
            screenMode: "alternate-screen",
        });
        try {
            await setup.renderOnce();
            await setup.renderer.idle();
            expect(capture.take()).toContain(WIRE_MARKER);

            // Pins the PREMISE of the bug being fixed: with nothing changed the renderer writes zero
            // bytes, so a screen wiped by the terminal receives nothing and stays blank. If opentui ever
            // stops diffing, this fails and the recovery machinery can be reconsidered.
            await setup.renderOnce();
            await setup.renderer.idle();
            expect(capture.take()).toBe("");

            forceFullRepaint(setup.renderer);
            await setup.renderOnce();
            await setup.renderer.idle();
            expect(capture.take()).toContain(WIRE_MARKER);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("forceFullRepaint", () => {
    test("the private opentui field it depends on still exists and is a boolean", async () => {
        const setup = await testRender(() => <Empty />, { width: 40, height: 8 });
        try {
            // `in` rather than a truthiness check: the resting value is false, so only presence
            // distinguishes "field exists" from "field was renamed and we are writing a typo".
            expect("forceFullRepaintRequested" in setup.renderer).toBe(true);
            expect(typeof repaintFlag(setup.renderer)).toBe("boolean");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("sets the flag, and the renderer consumes it on the next frame", async () => {
        const setup = await testRender(() => <Empty />, { width: 40, height: 8 });
        try {
            await setup.renderOnce();
            expect(repaintFlag(setup.renderer)).toBe(false);

            forceFullRepaint(setup.renderer);
            expect(repaintFlag(setup.renderer)).toBe(true);

            // One-shot: the render loop clears it, so repeated calls can never wedge the renderer
            // into permanently forcing full frames.
            await setup.renderOnce();
            expect(repaintFlag(setup.renderer)).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("the app.redraw key through the real keymap engine", () => {
    test("ctrl+l forces a full repaint, and keeps working while a modal is open", async () => {
        const setup = await testRender(() => <RedrawHarness />, { width: 40, height: 8 });
        try {
            await setup.renderOnce();
            expect(repaintFlag(setup.renderer)).toBe(false);

            setup.mockInput.pressKey("l", { ctrl: true });
            expect(repaintFlag(setup.renderer)).toBe(true);

            // Confirm the base-mode layer is genuinely suspended by the modal, so the redraw
            // assertion below is about modelessness and not about the mode stack being inert. The
            // no-modal press first, or "0 hits under a modal" would pass even if `z` never dispatched.
            await setup.renderOnce();
            baseModeHits = 0;
            setup.mockInput.pressKey("z");
            expect(baseModeHits).toBe(1);

            const popModal = pushMode(MODE_MODAL);
            setup.mockInput.pressKey("z");
            expect(baseModeHits).toBe(1);

            expect(repaintFlag(setup.renderer)).toBe(false);
            setup.mockInput.pressKey("l", { ctrl: true });
            expect(repaintFlag(setup.renderer)).toBe(true);
            popModal();
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("watchScreenDamage reaches every keystroke", () => {
    // The "press anything and the UI comes back" promise only holds if the observer sees keys that a
    // binding also consumes. It does, because the engine only ever calls preventDefault (which gates
    // renderable handlers, not the other global listeners) and never stopPropagation on a keypress —
    // pinned here so a future stopPropagation would fail loudly rather than silently narrowing the
    // heal to unbound keys.
    test("fires for a key a binding consumes, alongside that binding", async () => {
        let hits = 0;
        function Harness() {
            const renderer = useRenderer();
            useKeymapRoot();
            watchScreenDamage(renderer, { now: () => [0, REPAINT_IDLE_GAP_MS][Math.min(nowReads++, 1)]! });
            useBindings(() => ({ bindings: [{ chord: { key: "z" }, run: () => hits++ }] }));
            return <box width="100%" height="100%" />;
        }
        let nowReads = 0;

        const setup = await testRender(() => <Harness />, { width: 40, height: 8 });
        try {
            await setup.renderOnce();
            expect(repaintFlag(setup.renderer)).toBe(false);

            setup.mockInput.pressKey("z");
            expect(hits).toBe(1);
            expect(repaintFlag(setup.renderer)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("watchScreenDamage", () => {
    // The clock is injected so the idle gap is exercised without sleeping. Each case drives real
    // keypresses through opentui's key bus (mockInput), which is the same path a user's keystroke
    // takes — the observer has to be reached without any binding matching the key.
    async function harness(times: number[]) {
        let i = 0;
        const setup = await testRender(() => <Empty />, { width: 40, height: 8 });
        // Registered outside a component owner on purpose: onCleanup without an owner is a no-op and
        // the renderer is destroyed at the end of the test anyway.
        watchScreenDamage(setup.renderer, { now: () => times[Math.min(i++, times.length - 1)]! });
        return setup;
    }

    test("forces a repaint on the first keystroke after an idle gap", async () => {
        // now() reads: 0 = install, then the keypress lands a full gap later.
        const setup = await harness([0, REPAINT_IDLE_GAP_MS]);
        try {
            await setup.renderOnce();
            expect(repaintFlag(setup.renderer)).toBe(false);

            setup.mockInput.pressKey("a");
            expect(repaintFlag(setup.renderer)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("does not force a repaint while the user is actively typing", async () => {
        // Consecutive keys 20ms apart — a typing burst must never pay for a full frame.
        const setup = await harness([0, 20, 40, 60]);
        try {
            await setup.renderOnce();
            for (const k of ["a", "b", "c"]) {
                setup.mockInput.pressKey(k);
                expect(repaintFlag(setup.renderer)).toBe(false);
            }
        } finally {
            setup.renderer.destroy();
        }
    });
});
