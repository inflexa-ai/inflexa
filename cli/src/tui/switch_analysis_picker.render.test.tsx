import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";

import { freshDb } from "../test_support/db.ts";
import { __setClipboardWriterForTest } from "../lib/clipboard.ts";
import { contractHome } from "../lib/paths.ts";
import { str256 } from "../lib/types.ts";
import { createAnalysis } from "../modules/analysis/analysis.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../db/primary_mutation.ts";
import { useKeymapRoot } from "./keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { commands } from "./commands.tsx";
import type { Analysis } from "../types/analysis.ts";

// The Switch analysis picker is the ONE place the interface reports a whole-analysis total, so this
// drives the REAL command (`analysis.switch` → its dialog) against a REAL ledger rather than
// constructing rows by hand: the claim is that the figures a user compares analyses by come from the
// local SQLite this picker reads at open, with no harness runtime anywhere.

let dirA = "";
let dirB = "";

beforeEach(() => {
    freshDb();
    // realpath so the anchor markers the analyses mint match macOS's canonical /private/var.
    dirA = realpathSync(mkdtempSync(join(tmpdir(), "switch-a-")));
    dirB = realpathSync(mkdtempSync(join(tmpdir(), "switch-b-")));
});

afterEach(() => {
    dialogClear();
    for (const dir of [dirA, dirB]) rmSync(dir, { recursive: true, force: true });
});

function analysisIn(dir: string, name: string): Analysis {
    writeFileSync(join(dir, "one.txt"), "x");
    return createAnalysis({ cwd: dir, name: str256(name)._unsafeUnwrap(), inputPaths: [join(dir, "one.txt")] })._unsafeUnwrap();
}

function usageEntry(analysisId: string, recordKey: string, usage: LlmUsageEntry["usage"]): LlmUsageEntry {
    return {
        recordKey,
        recordedAt: 1_000,
        agentId: "conversation",
        callPath: "conversation",
        scopeKind: "analysis",
        scopeId: analysisId,
        threadId: "thr-1",
        usage,
    };
}

function ws(): Workspace {
    return {
        analysis: null,
        sessionId: null,
        workingDir: dirA,
        project: null,
        openDialog: () => {},
        closeDialog: () => {},
        openSession: () => {},
        quit: async () => {},
    };
}

/** The dialog host under a given workspace — closed over rather than passed as a prop, so the
 *  Provider's value is a plain constant (the shape `sidebar.render.test.tsx` uses). */
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

// A real-clock settle: the dialog host applies focus on a microtask and the list's seeded scroll
// retries on a macrotask, so a bare render pair is too early for both.
async function settle(setup: Setup): Promise<string> {
    await new Promise((r) => setTimeout(r, 20));
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

/** Run the real `analysis.switch` command and push the dialog it opens onto the host. */
function openSwitchPicker(workspace: Workspace): void {
    const command = commands.find((c) => c.id === "analysis.switch");
    expect(command).toBeDefined();
    // The command's whole body is `ctx.openDialog(...)`, so capturing that call IS the production path.
    void command!.run({ ...workspace, openDialog: (render) => dialogPush(render) });
}

describe("Switch analysis picker figures", () => {
    test("each row carries its OWN analysis's total, and an analysis with none carries no figure", async () => {
        const spent = analysisIn(dirA, "rna-seq");
        const untouched = analysisIn(dirB, "atac-seq");
        upsertLlmUsage(usageEntry(spent.id, "a-1", { inputTokens: 767_600, outputTokens: 33_100 }))._unsafeUnwrap();
        // A row belonging to ANOTHER analysis must not leak into either figure.
        upsertLlmUsage(usageEntry(untouched.id + "-nope", "a-2", { inputTokens: 999_000 }))._unsafeUnwrap();

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            openSwitchPicker(workspace);
            const frame = await settle(setup);

            const spentRow = frame.split("\n").find((l) => l.includes("rna-seq"));
            const untouchedRow = frame.split("\n").find((l) => l.includes("atac-seq"));
            expect(spentRow).toBeDefined();
            expect(untouchedRow).toBeDefined();

            expect(spentRow).toContain("↑767.6k ↓33.1k");
            // Never a zero, and never the other analysis's number: absence is absence. The arrows ARE
            // the figure — asserting on bare digits would catch the row's creation date instead, which
            // every row carries and which says nothing about usage.
            expect(untouchedRow).not.toContain("↑");
            expect(untouchedRow).not.toContain("↓");
            expect(frame).not.toContain("999.0k");
            // 800.7k is the two arms added — a figure no surface may invent.
            expect(frame).not.toContain("800.7k");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("every analysis stays listed and selectable, figures or not", async () => {
        analysisIn(dirA, "rna-seq");
        const second = analysisIn(dirB, "atac-seq");
        upsertLlmUsage(usageEntry(second.id, "b-1", { outputTokens: 40 }))._unsafeUnwrap();

        // The spies live on the CONTEXT workspace, not on the one handed to `run`: the dialog reads
        // `useWorkspace()`, and `openAnalysis` drives the swap through that same value.
        let chosen: Analysis | null = null;
        const workspace: Workspace = {
            ...ws(),
            openSession: (_threadId, _dir, analysis) => {
                chosen = analysis;
            },
        };
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            openSwitchPicker(workspace);
            await settle(setup);

            // A half figure keeps the arm it has rather than inventing the one it lacks. Asserted on
            // the ROW, not the frame: the list's own footer hint spells its move keys with arrows.
            const row = setup
                .captureCharFrame()
                .split("\n")
                .find((l) => l.includes("atac-seq"));
            expect(row).toContain("↓40");
            expect(row).not.toContain("↑");

            setup.mockInput.pressEnter();
            await settle(setup);
            expect(chosen).not.toBeNull();
        } finally {
            setup.renderer.destroy();
        }
    });
});

// A full run of this file emits one `Anchor is the same as the node <id> being inserted, skipping
// insertBefore` from opentui. It appears only with grouping on, and only across a multi-test run —
// no single test or pair reproduces it. It is NOT the row-drop of HORRIBLE_BUG_FIXES entry 1: that
// one is the `Anchor with id <id> does not exist` branch, which skips a node not yet in the tree.
// This branch is `renderable === anchor`, i.e. inserting a node before ITSELF, where skipping is
// what the operation already means. Every row and header asserted below renders, and the
// for_scrollbox sentinel (which covers grouped tuples) stays green.
describe("Switch analysis picker identity", () => {
    test("two analyses of one name are told apart by their anchor headers", async () => {
        // The reason this grouping exists: a slug is unique only WITHIN an anchor, so the same name
        // in two folders produces two rows that are identical down to the character.
        const inA = analysisIn(dirA, "A1");
        const inB = analysisIn(dirB, "A1");

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            openSwitchPicker(workspace);
            const frame = await settle(setup);

            const lines = frame.split("\n");
            expect(lines.filter((l) => l.includes("A1") && !l.includes(dirA) && !l.includes(dirB))).toHaveLength(2);
            const headers = lines.filter((l) => l.includes(dirA) || l.includes(dirB));
            expect(headers).toHaveLength(2);
            expect(headers.join("\n")).toContain(contractHome(dirA));
            expect(headers.join("\n")).toContain(contractHome(dirB));
            // The group KEY is the anchor id, and a header must print the folder instead. (The id is
            // on screen — the cursor row's detail line carries it deliberately — so this asks the
            // narrower question the grouping actually owns.)
            expect(headers.join("\n")).not.toContain(inA.anchorId);
            expect(headers.join("\n")).not.toContain(inB.anchorId);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the row date is absolute, and the cursor row gives the id and the slug", async () => {
        const only = analysisIn(dirA, "rna-seq");

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 110, height: 24 });
        try {
            await settle(setup);
            openSwitchPicker(workspace);
            const frame = await settle(setup);

            const row = frame.split("\n").find((l) => l.includes("rna-seq")) ?? "";
            expect(row).toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
            // A record listing reads on the absolute side of the time convention.
            expect(row).not.toMatch(/\b\d+[dhm] ago\b/);

            // The detail line of the cursor row is the one unambiguous handle for a row.
            expect(frame).toContain(only.id);
            expect(frame).toContain(only.slug);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("ctrl+y copies the cursor row's analysis id", async () => {
        const only = analysisIn(dirA, "rna-seq");
        const copied: string[] = [];
        const restore = __setClipboardWriterForTest(async (text) => {
            copied.push(text);
        });

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            openSwitchPicker(workspace);
            await settle(setup);

            await setup.mockInput.pressKeys(["\x19"]); // ctrl+y
            await settle(setup);
            expect(copied).toEqual([only.id]);
        } finally {
            restore();
            setup.renderer.destroy();
        }
    });

    test("a typed y filters instead of copying — the chord needs ctrl", async () => {
        analysisIn(dirA, "rna-seq");
        analysisIn(dirB, "yeast");
        const copied: string[] = [];
        const restore = __setClipboardWriterForTest(async (text) => {
            copied.push(text);
        });

        const workspace = ws();
        const setup = await testRender(harnessNode(workspace), { width: 100, height: 24 });
        try {
            await settle(setup);
            openSwitchPicker(workspace);
            await settle(setup);

            await setup.mockInput.pressKeys(["y"]);
            const frame = await settle(setup);
            expect(copied).toEqual([]);
            expect(frame).toContain("yeast");
        } finally {
            restore();
            setup.renderer.destroy();
        }
    });
});
