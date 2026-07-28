import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { TextareaRenderable } from "@opentui/core";

import { useKeymapRoot, useBindings, MODE_BASE, KEYS, __resetKeybindCache } from "./keymap.ts";
import { historyRecallLayer, retractLayer, type RecallPosition } from "./app.tsx";

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
    readonly hasEntries: () => boolean;
    readonly canRetract: () => boolean;
    /** Records that a chord reached its fall-through destination instead of being claimed by recall. */
    readonly onFallthrough: (chord: "up" | "down") => void;
    readonly onRef: (ta: TextareaRenderable) => void;
    /** Observes the recall position so a test can assert the layer left recall, not just that text matches. */
    readonly onPosition?: (position: RecallPosition | null) => void;
};

function RecallHarness(props: RecallControls) {
    useKeymapRoot();
    let ta: TextareaRenderable | null = null;
    const [position, setPosition] = createSignal<RecallPosition | null>(null);

    useBindings(() =>
        historyRecallLayer({
            target: ta,
            entries: props.entries,
            hasEntries: props.hasEntries,
            position,
            setPosition: (next) => {
                setPosition(next);
                props.onPosition?.(next);
            },
            conversation: { canRetract: props.canRetract },
        }),
    );

    // `preventDefault: false` so the key ALSO reaches the textarea's own caret handling — these stand-ins
    // observe the fall-through without suppressing what falls through, which is what lets the multi-line
    // cases below assert real caret movement rather than only the absence of a history step.
    useBindings(() => ({
        mode: MODE_BASE,
        target: ta,
        priority: -10,
        bindings: [
            { chord: KEYS.up, run: () => props.onFallthrough("up"), preventDefault: false },
            { chord: KEYS.down, run: () => props.onFallthrough("down"), preventDefault: false },
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
    // Counted so a test can pin that the transcript walk stays OFF the per-keystroke path.
    let entryReads = 0;
    const controls: RecallControls = {
        entries: () => {
            entryReads++;
            return opts.entries ?? ENTRIES;
        },
        hasEntries: () => (opts.entries ?? ENTRIES).length > 0,
        canRetract: () => opts.canRetract ?? false,
        onFallthrough: (chord) => fell.push(chord),
        onRef: (r) => (ta = r),
    };
    const setup = await testRender(() => <RecallHarness {...controls} />, { width: 40, height: 10 });
    const settle = makeSettle(setup);
    await settle();
    return { setup, settle, fell, composer: () => ta, entryReads: () => entryReads };
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

    test("up inside a recalled multi-line prompt walks the caret before stepping history", async () => {
        // The composer is multi-line and so are plenty of prompts. If recall held `up` for as long as the
        // entry sat in the buffer, every row but the last would be unreachable — the caret could never get
        // to line one to fix a typo there. History steps only from the FIRST row (the readline rule).
        const { setup, settle, fell, composer } = await mount({ entries: ["line one\nline two\nline three", "older prompt"] });
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().plainText).toBe("line one\nline two\nline three");
            // Seeded with the caret at the end — the last of three rows.
            expect(composer().editBuffer.getCursorPosition().row).toBe(2);

            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().editBuffer.getCursorPosition().row).toBe(1);
            expect(composer().plainText).toBe("line one\nline two\nline three");

            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().editBuffer.getCursorPosition().row).toBe(0);
            expect(composer().plainText).toBe("line one\nline two\nline three");

            // Only now, with no row left above, does `up` mean history again.
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().plainText).toBe("older prompt");
            expect(fell).toEqual(["up", "up"]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("down inside a recalled multi-line prompt walks the caret before leaving recall", async () => {
        const { setup, settle, composer } = await mount({ entries: ["line one\nline two\nline three"] });
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            // Walk up to the first row so there is somewhere for `down` to travel.
            setup.mockInput.pressArrow("up");
            await settle();
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().editBuffer.getCursorPosition().row).toBe(0);

            setup.mockInput.pressArrow("down");
            await settle();
            expect(composer().editBuffer.getCursorPosition().row).toBe(1);
            expect(composer().plainText).toBe("line one\nline two\nline three");

            setup.mockInput.pressArrow("down");
            await settle();
            expect(composer().editBuffer.getCursorPosition().row).toBe(2);
            expect(composer().plainText).toBe("line one\nline two\nline three");

            // Last row reached: `down` now leaves recall and restores the empty composer.
            setup.mockInput.pressArrow("down");
            await settle();
            expect(composer().plainText).toBe("");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a single-line entry recalls in both directions with no extra keystrokes", async () => {
        // A one-row buffer is the first AND last row at once, so the caret rule costs nothing in the common
        // case — this is what keeps single-line recall a single press in each direction.
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

    test("an abandoned recall does not leave the transcript walk armed on every keystroke", async () => {
        // `activeLayers` re-invokes every layer's thunk on EVERY key, before filtering on `enabled`. A
        // position outlives its recall — nothing clears it on an edit, a submit, a clear-input, or a session
        // swap — so a liveness check that reached into the entry list would keep walking the whole mounted
        // transcript on every keystroke in the app, dialogs included, for the rest of the session. The
        // position carries its own text precisely so that check costs a string compare instead.
        const { setup, settle, composer, entryReads } = await mount();
        try {
            setup.mockInput.pressArrow("up");
            await settle();
            expect(composer().plainText).toBe("newest");

            // One press that actually stepped history — that is the only thing allowed to build the list.
            const afterRecall = entryReads();
            expect(afterRecall).toBe(1);

            // Abandon the recall by editing, leaving a stale position behind, then type on.
            await setup.mockInput.typeText("!");
            await settle();
            await setup.mockInput.typeText("more text here");
            await settle();
            setup.mockInput.pressArrow("up");
            await settle();
            setup.mockInput.pressArrow("down");
            await settle();

            expect(entryReads()).toBe(afterRecall);
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
            const [position, setPosition] = createSignal<RecallPosition | null>(null);
            const seam = {
                canRetract: () => retractable(),
                retract: (seed: (text: string) => void) => {
                    retractCalls++;
                    seed("retracted");
                    return Promise.resolve();
                },
            };
            useBindings(() => retractLayer({ target: inner, conversation: seam }));
            useBindings(() =>
                historyRecallLayer({
                    target: inner,
                    entries: () => ENTRIES,
                    hasEntries: () => ENTRIES.length > 0,
                    position,
                    setPosition,
                    conversation: seam,
                }),
            );
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
