import { afterEach, describe, expect, test } from "bun:test";
import { For } from "solid-js";
import { testRender } from "@opentui/solid";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { useKeymapRoot, useBindings, MODE_BASE, KEYS, __resetKeybindCache } from "./keymap.ts";
import { interruptLayer, retractLayer } from "./app.tsx";
import { ScrollPane } from "./components/scroll_pane.tsx";

// End-to-end verification of app.tsx's two chat key layers — up-arrow RETRACT and double-press INTERRUPT
// — through the REAL engine: mockInput drives opentui's keyboard bus → useKeymapRoot → dispatchKey → the
// winning layer. The App itself needs the whole workspace/DB/conversation stack to mount (out of scope
// here — tsc covers App's wiring), so each Harness registers the ACTUAL factory under test — app.tsx's
// exported `retractLayer`/`interruptLayer` — over the same conversation-hook SEAM `App` passes in, but
// with an injected fake so a dispatch can be observed without a live turn. This is the same "install the
// real layer, not a hand-copied replica" contract as keymap_selection.render.test.tsx, so the tests can
// never drift from app.tsx's real config. The only stand-ins are minimal lower-priority destinations that
// give the key its real place to land when the layer under test is disabled (fall-through).

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i}`);

afterEach(() => {
    __resetKeybindCache();
});

// A lone ESC byte is an ambiguous escape-sequence prefix: opentui's StdinParser holds it for timeoutMs
// (20ms) before flushing it as a standalone "escape" key — so yield real time, not just renderOnce spins,
// for esc to reach the dispatcher. (Same helper as the other keymap render tests; harmless for arrows.)
function makeSettle(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
    return async () => {
        await new Promise((r) => setTimeout(r, 35));
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

// ── up-arrow RETRACT ──────────────────────────────────────────────────────────────────────────────

/** The retract seam a test injects: a controllable `canRetract` gate + a `retract` spy that seeds. */
type RetractControls = {
    readonly conversation: { canRetract: () => boolean; retract: (seed: (text: string) => void) => Promise<void> };
    readonly onFallthrough: () => void;
    readonly onRef: (ta: TextareaRenderable) => void;
};

function RetractHarness(props: RetractControls) {
    useKeymapRoot();
    let ta: TextareaRenderable | null = null;

    // The REAL layer under test: app.tsx's exported factory over the injected conversation seam, so the
    // test exercises app.tsx's actual gate (empty-buffer AND retractable) rather than a copy that drifts.
    useBindings(() => retractLayer({ target: ta, conversation: props.conversation }));

    // A minimal stand-in for `up`'s real fall-through destination (the textarea's own cursor movement in
    // production): a lower-priority up binding that records it was reached, so a DISABLED retract layer
    // proves the key fell through rather than merely not firing.
    useBindings(() => ({
        mode: MODE_BASE,
        target: ta,
        priority: -10,
        bindings: [{ chord: KEYS.up, run: () => props.onFallthrough() }],
    }));

    return (
        <box flexDirection="column" width="100%" height="100%">
            <textarea
                ref={(r: TextareaRenderable) => {
                    ta = r;
                    queueMicrotask(() => r.focus());
                    props.onRef(r);
                }}
            />
        </box>
    );
}

describe("up-arrow retract layer (rendered, real keyboard bus)", () => {
    test("empty buffer + open window: up runs the retract and seeds the composer", async () => {
        let ta!: TextareaRenderable;
        let retractCalls = 0;
        let fallthroughCalls = 0;
        const controls: RetractControls = {
            conversation: {
                canRetract: () => true,
                retract: (seed) => {
                    retractCalls++;
                    seed("seeded text"); // the widget seam app.tsx wires to setText + gotoBufferEnd
                    return Promise.resolve();
                },
            },
            onFallthrough: () => (fallthroughCalls += 1),
            onRef: (r) => (ta = r),
        };
        const setup = await testRender(() => <RetractHarness {...controls} />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();
            expect(ta.focused).toBe(true);
            expect(ta.plainText).toBe("");

            setup.mockInput.pressArrow("up");
            await settle();

            // The layer fired the retract (not the fall-through), and the seed reached the composer.
            expect(retractCalls).toBe(1);
            expect(fallthroughCalls).toBe(0);
            expect(ta.plainText).toBe("seeded text");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a buffer typed into during the retract declines the seed rather than being overwritten", async () => {
        // The gate that armed the retract saw an empty composer, but the retract spans an abort, a turn
        // settlement, and a durable removal with the composer still focused — long enough for the user to
        // start typing a replacement. The seed is a request the widget may refuse, and here it must.
        let ta!: TextareaRenderable;
        const controls: RetractControls = {
            conversation: {
                canRetract: () => true,
                retract: async (seed) => {
                    // Stand in for the user typing while the durable half of the retract is in flight.
                    ta.setText("a replacement typed mid-retract");
                    seed("original text");
                },
            },
            onFallthrough: () => {},
            onRef: (r) => (ta = r),
        };
        const setup = await testRender(() => <RetractHarness {...controls} />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();
            expect(ta.plainText).toBe("");

            setup.mockInput.pressArrow("up");
            await settle();

            // The user's own keystrokes won — the restoration did not clobber them.
            expect(ta.plainText).toBe("a replacement typed mid-retract");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("non-empty buffer: the binding is disabled and up falls through", async () => {
        let ta!: TextareaRenderable;
        let retractCalls = 0;
        let fallthroughCalls = 0;
        const controls: RetractControls = {
            // canRetract would allow it, but a typed buffer is the OTHER half of the gate — it must veto.
            conversation: { canRetract: () => true, retract: () => ((retractCalls += 1), Promise.resolve()) },
            onFallthrough: () => (fallthroughCalls += 1),
            onRef: (r) => (ta = r),
        };
        const setup = await testRender(() => <RetractHarness {...controls} />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();
            await setup.mockInput.typeText("hello");
            await settle();
            expect(ta.plainText).toBe("hello");

            setup.mockInput.pressArrow("up");
            await settle();

            // Empty-buffer gate vetoes: the retract never ran, and up reached the fall-through stand-in.
            expect(retractCalls).toBe(0);
            expect(fallthroughCalls).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("idle window: the binding is disabled and up falls through", async () => {
        let retractCalls = 0;
        let fallthroughCalls = 0;
        const controls: RetractControls = {
            conversation: { canRetract: () => false, retract: () => ((retractCalls += 1), Promise.resolve()) },
            onFallthrough: () => (fallthroughCalls += 1),
            onRef: () => {},
        };
        const setup = await testRender(() => <RetractHarness {...controls} />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();

            setup.mockInput.pressArrow("up");
            await settle();

            // No retract window → disabled → up falls through to the stand-in, never the retract.
            expect(retractCalls).toBe(0);
            expect(fallthroughCalls).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });
});

// ── double-press INTERRUPT ────────────────────────────────────────────────────────────────────────

/** The interrupt seam a test injects: a controllable armed flag, an `armInterrupt` spy that flips it, an `abort` spy. */
type InterruptControls = {
    readonly conversation: { interruptArmed: () => boolean; armInterrupt: () => void; abort: () => void };
    readonly busy: () => boolean;
    readonly selectedText: () => string;
    readonly onFallthrough: () => void;
    readonly onRef: (pane: ScrollBoxRenderable) => void;
};

function InterruptHarness(props: InterruptControls) {
    useKeymapRoot();
    let pane: ScrollBoxRenderable | null = null;

    // The REAL layer under test: app.tsx's exported factory over the injected seam + enable inputs, so the
    // busy/selection gate and the arm→fire dispatch are app.tsx's own, not a copy.
    useBindings(() =>
        interruptLayer({
            target: pane,
            busy: props.busy,
            selectedText: props.selectedText,
            conversation: props.conversation,
        }),
    );

    // A minimal stand-in for esc's real destination in NORMAL mode (the deliberate no-op in production): a
    // lower-priority pane-targeted esc that records it was reached, so a DISABLED interrupt layer proves
    // esc fell through rather than merely not arming.
    useBindings(() => ({
        mode: MODE_BASE,
        target: pane,
        priority: -10,
        bindings: [{ chord: KEYS.escape, run: () => props.onFallthrough() }],
    }));

    return (
        <box flexDirection="column" width="100%" height="100%">
            <ScrollPane focusOnMount flexGrow={1} onRef={(r: ScrollBoxRenderable) => ((pane = r), props.onRef(r))}>
                <For each={LINES}>{(l) => <text>{l}</text>}</For>
            </ScrollPane>
        </box>
    );
}

describe("double-press interrupt layer (rendered, real keyboard bus)", () => {
    test("busy + no selection: first esc arms, second esc fires abort", async () => {
        let pane!: ScrollBoxRenderable;
        let armed = false;
        let armCalls = 0;
        let abortCalls = 0;
        let fallthroughCalls = 0;
        const controls: InterruptControls = {
            conversation: {
                interruptArmed: () => armed,
                armInterrupt: () => ((armCalls += 1), (armed = true)),
                abort: () => (abortCalls += 1),
            },
            busy: () => true,
            selectedText: () => "",
            onFallthrough: () => (fallthroughCalls += 1),
            onRef: (r) => (pane = r),
        };
        const setup = await testRender(() => <InterruptHarness {...controls} />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();
            expect(pane.focused).toBe(true);

            // First esc: not yet armed → arm the window, no abort.
            setup.mockInput.pressEscape();
            await settle();
            expect(armCalls).toBe(1);
            expect(abortCalls).toBe(0);

            // Second esc: armed → fire the abort.
            setup.mockInput.pressEscape();
            await settle();
            expect(armCalls).toBe(1);
            expect(abortCalls).toBe(1);
            // The interrupt layer owned both presses — esc never reached the fall-through stand-in.
            expect(fallthroughCalls).toBe(0);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a live selection excludes the interrupt: esc does not arm", async () => {
        let armCalls = 0;
        let abortCalls = 0;
        let fallthroughCalls = 0;
        const controls: InterruptControls = {
            conversation: { interruptArmed: () => false, armInterrupt: () => (armCalls += 1), abort: () => (abortCalls += 1) },
            busy: () => true,
            selectedText: () => "SELECTED", // a live selection is present
            onFallthrough: () => (fallthroughCalls += 1),
            onRef: () => {},
        };
        const setup = await testRender(() => <InterruptHarness {...controls} />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();

            setup.mockInput.pressEscape();
            await settle();

            // enabled excludes it while text is selected → no arm, no abort; esc falls through.
            expect(armCalls).toBe(0);
            expect(abortCalls).toBe(0);
            expect(fallthroughCalls).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("idle: the layer is inert and esc falls through", async () => {
        let armCalls = 0;
        let abortCalls = 0;
        let fallthroughCalls = 0;
        const controls: InterruptControls = {
            conversation: { interruptArmed: () => false, armInterrupt: () => (armCalls += 1), abort: () => (abortCalls += 1) },
            busy: () => false, // no turn in flight
            selectedText: () => "",
            onFallthrough: () => (fallthroughCalls += 1),
            onRef: () => {},
        };
        const setup = await testRender(() => <InterruptHarness {...controls} />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();

            setup.mockInput.pressEscape();
            await settle();

            // Idle → disabled → esc is the deliberate no-op, reaching only the fall-through stand-in.
            expect(armCalls).toBe(0);
            expect(abortCalls).toBe(0);
            expect(fallthroughCalls).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });
});
