import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { TextareaRenderable } from "@opentui/core";

import { useKeymapRoot, useBindings, MODE_BASE, KEYS, __resetKeybindCache } from "./keymap.ts";
import { historyRecallLayer, retractLayer } from "./app.tsx";

// End-to-end verification of app.tsx's prompt-history recall layer through the REAL engine: mockInput
// drives opentui's keyboard bus → useKeymapRoot → dispatchKey → the winning layer. Same contract as
// keymap_interrupt_retract.render.test.tsx — the harness registers the ACTUAL exported factory over
// injected seams, never a hand-copied replica, so these tests cannot drift from app.tsx's real config.
// The only stand-in is a lower-priority up/down pair giving each chord its real place to land when the
// recall layer declines it (the textarea's own cursor movement in production).

afterEach(() => {
    __resetKeybindCache();
});

// Newest first, exactly as `conversation.promptHistory` returns them.
const ENTRIES = ["newest", "middle", "oldest"];

function makeSettle(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
    return async () => {
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

type RecallControls = {
    readonly entries: () => string[];
    readonly canRetract: () => boolean;
    /** Records that a chord reached its fall-through destination instead of being claimed by recall. */
    readonly onFallthrough: (chord: "up" | "down") => void;
    readonly onRef: (ta: TextareaRenderable) => void;
    /** Observes the recall position so a test can assert the layer left recall, not just that text matches. */
    readonly onIndex?: (index: number | null) => void;
};

function RecallHarness(props: RecallControls) {
    useKeymapRoot();
    let ta: TextareaRenderable | null = null;
    const [index, setIndex] = createSignal<number | null>(null);

    useBindings(() =>
        historyRecallLayer({
            target: ta,
            entries: props.entries,
            index,
            setIndex: (next) => {
                setIndex(next);
                props.onIndex?.(next);
            },
            conversation: { canRetract: props.canRetract },
        }),
    );

    useBindings(() => ({
        mode: MODE_BASE,
        target: ta,
        priority: -10,
        bindings: [
            { chord: KEYS.up, run: () => props.onFallthrough("up") },
            { chord: KEYS.down, run: () => props.onFallthrough("down") },
        ],
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

/** Mount the harness and hand back the composer, a settle pump, and the fall-through tally. */
async function mount(opts: { entries?: string[]; canRetract?: boolean } = {}) {
    let ta!: TextareaRenderable;
    const fell: ("up" | "down")[] = [];
    const controls: RecallControls = {
        entries: () => opts.entries ?? ENTRIES,
        canRetract: () => opts.canRetract ?? false,
        onFallthrough: (chord) => fell.push(chord),
        onRef: (r) => (ta = r),
    };
    const setup = await testRender(() => <RecallHarness {...controls} />, { width: 40, height: 10 });
    const settle = makeSettle(setup);
    await settle();
    return { setup, settle, fell, composer: () => ta };
}

describe("prompt-history recall layer (rendered, real keyboard bus)", () => {
    test("up on an empty composer recalls the newest prompt", async () => {
        const { setup, settle, fell, composer } = await mount();
        try {
            expect(composer().focused).toBe(true);
            expect(composer().plainText).toBe("");

            setup.mockInput.pressArrow("up");
            await settle();

            expect(composer().plainText).toBe("newest");
            expect(fell).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a second up steps to the next-older prompt", async () => {
        // The case a bare empty-buffer gate would strand: the first seed makes the buffer non-empty, so
        // recall has to survive its own seed to reach anything past the newest entry.
        const { setup, settle, fell, composer } = await mount();
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            setup.mockInput.pressArrow("up");
            await settle();

            expect(composer().plainText).toBe("middle");
            expect(fell).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("up at the oldest entry holds rather than falling off the end", async () => {
        const { setup, settle, composer } = await mount();
        try {
            for (let i = 0; i < 3; i++) {
                setup.mockInput.pressArrow("up");
                await settle();
            }
            expect(composer().plainText).toBe("oldest");

            setup.mockInput.pressArrow("up");
            await settle();

            expect(composer().plainText).toBe("oldest");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("editing a recalled prompt hands the cursor keys back", async () => {
        const { setup, settle, fell, composer } = await mount();
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().plainText).toBe("newest");

            await setup.mockInput.typeText("!");
            await settle();
            expect(composer().plainText).toBe("newest!");

            setup.mockInput.pressArrow("up");
            await settle();

            // The buffer no longer equals the entry it was seeded from, so the layer is inert and `up`
            // reached its fall-through destination — no further recall, no clobbered edit.
            expect(fell).toEqual(["up"]);
            expect(composer().plainText).toBe("newest!");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("down from the newest entry restores the empty composer", async () => {
        const { setup, settle, composer } = await mount();
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().plainText).toBe("newest");

            setup.mockInput.pressArrow("down");
            await settle();

            expect(composer().plainText).toBe("");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("down walks back toward the newest before leaving recall", async () => {
        const { setup, settle, composer } = await mount();
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().plainText).toBe("middle");

            setup.mockInput.pressArrow("down");
            await settle();

            expect(composer().plainText).toBe("newest");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("down outside a recall is left to the editor", async () => {
        const { setup, settle, fell, composer } = await mount();
        try {
            setup.mockInput.pressArrow("down");
            await settle();

            // Nothing to step forward to, so the chord is not bound at all this keystroke — it falls
            // through rather than being swallowed to run a no-op.
            expect(fell).toEqual(["down"]);
            expect(composer().plainText).toBe("");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("re-entering recall resumes at the newest, not the abandoned position", async () => {
        const { setup, settle, composer } = await mount();
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().plainText).toBe("middle");

            // Abandon the recall by clearing the composer, as ctrl+u or an accepted submit would.
            composer().setText("");
            await settle();

            setup.mockInput.pressArrow("up");
            await settle();

            // The stale position (1) is discarded — entry from an empty buffer always resumes at 0.
            expect(composer().plainText).toBe("newest");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("identical prompts separated by another each keep their place", async () => {
        // The non-adjacent-duplicate trap the STORED position exists for: searching the entry list for the
        // buffer's text would resolve the older "A" to index 0 and jump back to "B" instead of "before".
        const { setup, settle, composer } = await mount({ entries: ["A", "B", "A", "before"] });
        try {
            for (let i = 0; i < 3; i++) {
                setup.mockInput.pressArrow("up");
                await settle();
            }
            expect(composer().plainText).toBe("A");

            setup.mockInput.pressArrow("up");
            await settle();

            expect(composer().plainText).toBe("before");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an empty history leaves up to the editor", async () => {
        const { setup, settle, fell, composer } = await mount({ entries: [] });
        try {
            setup.mockInput.pressArrow("up");
            await settle();

            expect(fell).toEqual(["up"]);
            expect(composer().plainText).toBe("");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an open retract window keeps up for the retract", async () => {
        const { setup, settle, fell, composer } = await mount({ canRetract: true });
        try {
            setup.mockInput.pressArrow("up");
            await settle();

            // The `!canRetract()` gate makes recall and retract mutually exclusive: recall declined, so the
            // key reached the stand-in that the real retract layer occupies in production.
            expect(composer().plainText).toBe("");
            expect(fell).toEqual(["up"]);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("recall and retract never both claim the composer's up", () => {
    test("the two layers' gates are exact complements at every retract state", async () => {
        // Both factories target the composer and bind `up`. Registering BOTH — as `App` does — and driving
        // the real bus proves the mutual exclusion is structural rather than a priority tiebreak: whichever
        // way `canRetract` reads, exactly one of them acts.
        let ta!: TextareaRenderable;
        let retractCalls = 0;
        const [retractable, setRetractable] = createSignal(true);

        function BothHarness() {
            useKeymapRoot();
            let inner: TextareaRenderable | null = null;
            const [index, setIndex] = createSignal<number | null>(null);
            const seam = {
                canRetract: () => retractable(),
                retract: (seed: (text: string) => void) => {
                    retractCalls++;
                    seed("retracted");
                    return Promise.resolve();
                },
            };
            useBindings(() => retractLayer({ target: inner, conversation: seam }));
            useBindings(() => historyRecallLayer({ target: inner, entries: () => ENTRIES, index, setIndex, conversation: seam }));
            return (
                <box flexDirection="column" width="100%" height="100%">
                    <textarea
                        ref={(r: TextareaRenderable) => {
                            inner = r;
                            queueMicrotask(() => r.focus());
                            ta = r;
                        }}
                    />
                </box>
            );
        }

        const setup = await testRender(() => <BothHarness />, { width: 40, height: 10 });
        const settle = makeSettle(setup);
        try {
            await settle();

            // Window open: the retract wins and recall stays out of the way.
            setup.mockInput.pressArrow("up");
            await settle();
            expect(retractCalls).toBe(1);
            expect(ta.plainText).toBe("retracted");

            // Window closed (first output arrived, turn possibly still busy): recall takes the chord over.
            ta.setText("");
            setRetractable(false);
            await settle();

            setup.mockInput.pressArrow("up");
            await settle();
            expect(retractCalls).toBe(1);
            expect(ta.plainText).toBe("newest");
        } finally {
            setup.renderer.destroy();
        }
    });
});
