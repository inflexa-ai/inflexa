import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { useKeymapRoot, __resetKeybindCache } from "../../keymap.ts";
import { DialogOverlay, dialogPush, dialogClear } from "./dialog_host.tsx";
import { ResultsDialog, type ResultsAction } from "./results_dialog.tsx";

// The `action` prop is the dialog's only conditional surface, and both halves of the condition are
// load-bearing: the FOOTER advertises a key, and `useDialogBindings` makes that key do something. They
// are written as two separate `enabled` reads, so they can disagree — a dialog that advertises
// `r re-profile` and ignores `r`, or (worse) one that silently binds a key it never advertised. Drive
// the real keyboard bus rather than inspect props: the binding only exists inside a mounted keymap
// root, and the footer only exists as painted text.

afterEach(() => {
    __resetKeybindCache();
    dialogClear();
});

const LINES = ["alpha", "beta"];

/** Key modifiers `mockInput.pressKey` accepts — only the ones a chord can carry. */
type Mods = { ctrl?: boolean; shift?: boolean };

/**
 * Mount a `ResultsDialog` through the real dialog host (`dialogPush` + `DialogOverlay`) under a keymap
 * root, so its `useDialogBindings` layer is live and gated on `isTop` exactly as in production.
 */
async function mount(action?: ResultsAction, onClose: () => void = () => {}) {
    const setup = await testRender(
        () => {
            useKeymapRoot();
            return (
                <box width="100%" height="100%">
                    <DialogOverlay />
                </box>
            );
        },
        { width: 90, height: 30 },
    );
    dialogPush(() => <ResultsDialog title="results" lines={LINES} emptyText="none" action={action} onClose={onClose} />);
    await setup.renderOnce();
    await setup.renderOnce();

    return {
        frame: (): string =>
            setup
                .captureCharFrame()
                .split("\n")
                .map((line) => line.trimEnd())
                .join("\n")
                .trimEnd(),
        press: async (key: string, mods?: Mods): Promise<void> => {
            setup.mockInput.pressKey(key, mods);
            await setup.renderOnce();
        },
        // A leaked renderer holds native handles open and can segfault a later render (CLAUDE.md).
        dispose: (): void => setup.renderer.destroy(),
    };
}

function action(overrides: Partial<ResultsAction> = {}): ResultsAction {
    return { key: "r", label: "re-profile", enabled: true, onAction: () => {}, ...overrides };
}

describe("ResultsDialog footer", () => {
    test("with no action → scroll + close only", async () => {
        const h = await mount();
        try {
            expect(h.frame()).toContain("close");
            expect(h.frame()).not.toContain("re-profile");
        } finally {
            h.dispose();
        }
    });

    test("an enabled action appends `key label` after the close hint", async () => {
        const h = await mount(action());
        try {
            const frame = h.frame();
            expect(frame).toContain("re-profile");
            // Advertised AFTER close, not spliced in before it.
            expect(frame.indexOf("close")).toBeLessThan(frame.indexOf("re-profile"));
        } finally {
            h.dispose();
        }
    });

    test("a DISABLED action renders byte-identically to no action at all", async () => {
        // The prop doc's claim ("with no `action` prop the dialog is byte-identical to before"), extended
        // to the disabled case: the footer must leave behind no stray separator and no dimmed hint.
        const bareHost = await mount();
        let bare: string;
        try {
            bare = bareHost.frame();
        } finally {
            bareHost.dispose();
        }

        const disabledHost = await mount(action({ enabled: false }));
        try {
            expect(disabledHost.frame()).toBe(bare);
        } finally {
            disabledHost.dispose();
        }
    });
});

describe("ResultsDialog action binding", () => {
    test("an enabled action's key runs it; the close keys still close", async () => {
        let ran = 0;
        let closed = 0;
        const h = await mount(
            action({
                onAction: () => {
                    ran += 1;
                },
            }),
            () => {
                closed += 1;
            },
        );
        try {
            await h.press("r");
            expect(ran).toBe(1);
            expect(closed).toBe(0);

            await h.press("q");
            expect(closed).toBe(1);
        } finally {
            h.dispose();
        }
    });

    test("a disabled action binds nothing — its key is inert, not a no-op handler", async () => {
        let ran = 0;
        const h = await mount(
            action({
                enabled: false,
                onAction: () => {
                    ran += 1;
                },
            }),
        );
        try {
            await h.press("r");
            expect(ran).toBe(0);
        } finally {
            h.dispose();
        }
    });

    test("the action key goes through parseChord, not a raw string compare", async () => {
        let ran = 0;
        const h = await mount(
            action({
                key: "ctrl+e",
                label: "export",
                onAction: () => {
                    ran += 1;
                },
            }),
        );
        try {
            // A raw-string binding on "ctrl+e" would never match any keypress; a bare-`e` binding would
            // match the wrong one. Only a parsed chord distinguishes these two presses.
            await h.press("e");
            expect(ran).toBe(0);

            await h.press("e", { ctrl: true });
            expect(ran).toBe(1);
        } finally {
            h.dispose();
        }
    });
});
