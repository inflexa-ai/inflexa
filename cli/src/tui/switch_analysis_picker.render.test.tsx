import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";

import { freshDb } from "../test_support/db.ts";
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
            // Never a zero, and never the other analysis's number: absence is absence.
            expect(untouchedRow).not.toContain("↑");
            expect(untouchedRow).not.toContain("0");
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
