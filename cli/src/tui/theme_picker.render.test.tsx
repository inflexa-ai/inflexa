import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import type { JSX } from "solid-js";
import { testRender } from "@opentui/solid";

import { env } from "../lib/env.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { DEFAULT_THEME_ID, type ThemeId } from "../lib/design_system.ts";
import { useKeymapRoot } from "./keymap.ts";
import { setTheme, themeId } from "./theme.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { ThemePicker } from "./commands.tsx";

// The preview contract, driven through the REAL picker, dialog host and keyboard bus — the only place
// it is observable, because preview/revert live entirely in the gap between the active theme signal and
// what is on disk. Two facts every case turns on: `theme()` is one global signal (so "the active theme"
// is `themeId()`), and the XDG test sandbox gives this process its own config.json (so "persisted" is
// that file, asserted raw rather than through readConfig's fallbacks).

// The persisted theme is deliberately NOT the default: seeding on row 0 would coincide with the
// persisted row under tokyo-night and hide exactly the flash this change exists to remove. `nord` sits
// mid-list, so a seed failure shows up as a visible cursor/preview on the first row.
const PERSISTED: ThemeId = "nord";
/** The row directly below {@link PERSISTED} in the picker's fixed listing order. */
const NEXT_DOWN: ThemeId = "rose-pine";

/** The theme id as it was actually written to disk — the ground truth for "persisted". */
function persistedTheme(): string | undefined {
    const parsed = JSON.parse(readFileSync(env.configPath, "utf8")) as { theme?: string };
    return parsed.theme;
}

/** A workspace stub: the picker only ever reaches for `closeDialog`, and records it. */
function stubWorkspace(onClose: () => void): Workspace {
    return {
        analysis: null,
        sessionId: "session-under-test",
        workingDir: process.cwd(),
        project: null,
        openDialog: () => {},
        closeDialog: onClose,
        openSession: () => {},
        quit: async () => {},
    };
}

type Setup = Awaited<ReturnType<typeof testRender>>;

// A lone ESC byte is an ambiguous escape-sequence prefix (opentui's parser holds it ~20ms before
// flushing it as a standalone key), so esc only arrives after a real-clock wait.
async function settle(setup: Setup): Promise<void> {
    await new Promise((r) => setTimeout(r, 35));
    await setup.renderOnce();
    await setup.renderOnce();
}

/** Mount the picker over the real dialog host, with the persisted theme already active (as launch does). */
async function openPicker(setup: Setup, onClose: () => void): Promise<void> {
    writeConfig({ ...readConfig(), theme: PERSISTED })._unsafeUnwrap();
    setTheme(PERSISTED);
    await settle(setup);
    dialogPush(() => (
        <WorkspaceContext.Provider value={stubWorkspace(onClose)}>
            <ThemePicker />
        </WorkspaceContext.Provider>
    ));
    await settle(setup);
}

function Harness(): JSX.Element {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            <DialogOverlay />
        </box>
    );
}

describe("ThemePicker live preview", () => {
    afterEach(() => {
        dialogClear();
        // Both are process-global: a leaked preview or a saved theme would seed every later test.
        setTheme(DEFAULT_THEME_ID);
        rmSync(env.configPath, { force: true });
    });

    test("opening previews nothing: the cursor starts on the persisted theme", async () => {
        const setup = await testRender(() => <Harness />, { width: 80, height: 30 });
        try {
            await openPicker(setup, () => {});
            expect(themeId()).toBe(PERSISTED);
            expect(persistedTheme()).toBe(PERSISTED);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("moving the cursor applies the highlighted theme without persisting it", async () => {
        const setup = await testRender(() => <Harness />, { width: 80, height: 30 });
        try {
            await openPicker(setup, () => {});

            setup.mockInput.pressArrow("down");
            await settle(setup);
            expect(themeId()).toBe(NEXT_DOWN);
            expect(persistedTheme()).toBe(PERSISTED); // the preview never touched the file
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a filter matching nothing reverts to the persisted theme; matching rows resume the preview", async () => {
        const setup = await testRender(() => <Harness />, { width: 80, height: 30 });
        try {
            await openPicker(setup, () => {});

            setup.mockInput.pressArrow("down");
            await settle(setup);
            expect(themeId()).toBe(NEXT_DOWN);

            await setup.mockInput.typeText("zzzz"); // no theme name matches
            await settle(setup);
            expect(themeId()).toBe(PERSISTED);

            for (let i = 0; i < 4; i++) setup.mockInput.pressBackspace();
            await setup.mockInput.typeText("latte"); // one match: Catppuccin Latte
            await settle(setup);
            expect(themeId()).toBe("catppuccin-latte");
            expect(persistedTheme()).toBe(PERSISTED);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("esc reverts the previewed theme and closes", async () => {
        let closed = 0;
        const setup = await testRender(() => <Harness />, { width: 80, height: 30 });
        try {
            await openPicker(setup, () => closed++);

            setup.mockInput.pressArrow("down");
            await settle(setup);
            expect(themeId()).toBe(NEXT_DOWN);

            setup.mockInput.pressEscape();
            await settle(setup);
            expect(closed).toBe(1);
            expect(themeId()).toBe(PERSISTED);
            expect(persistedTheme()).toBe(PERSISTED);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("enter commits the previewed theme: it stays active and is persisted", async () => {
        let closed = 0;
        const setup = await testRender(() => <Harness />, { width: 80, height: 30 });
        try {
            await openPicker(setup, () => closed++);

            setup.mockInput.pressArrow("down");
            setup.mockInput.pressEnter();
            await settle(setup);
            expect(closed).toBe(1);
            expect(themeId()).toBe(NEXT_DOWN);
            expect(persistedTheme()).toBe(NEXT_DOWN);
        } finally {
            setup.renderer.destroy();
        }
    });
});
