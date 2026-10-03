import { afterEach, describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import { createRoot } from "solid-js";

import type { FarmHealOutcome } from "../../api/runs.ts";
import type { TransferReportView } from "../../api/store.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { Notice } from "../theme.ts";
import { __resetSandboxGateForTest, __setTransferReportsForTest } from "./sandbox_gate.tsx";
import { __resetFarmHealForTest, watchFarmHeal, type FarmHealSeams } from "./farm_heal.tsx";

// The two heal triggers of the open session, driven offline: the seams carry
// the filesystem answers and the effects as spies, and the transfer signal is
// written directly. The heal itself is composition.test.ts territory.

// The hook reads only `.id` off the analysis.
const ANALYSIS = { id: "a1", name: "My analysis" } as unknown as Analysis;

/** A workspace stub: the hook reads `analysis`, and the injected seams carry the dialog. */
function wsWith(analysis: Analysis | null): Workspace {
    return { analysis } as unknown as Workspace;
}

/** One catalog transfer report in the row shape, with everything else quiet. */
function catalogReport(state: "running" | "installed", live: boolean): TransferReportView {
    return { kind: "catalog", row: null, state, live, holderPid: live ? 4242 : null };
}

type Recorded = {
    readonly seams: FarmHealSeams;
    readonly healed: string[];
    readonly notices: Notice[];
    readonly prompts: ((yes: boolean) => void)[];
    readonly started: () => number;
};

/**
 * Options whose answers a test fixes and whose effects record. `heal` answers as the route does for a
 * farm-less analysis with the catalog present: it composes.
 */
function recordedSeams(over: Partial<FarmHealSeams> & { outcome?: FarmHealOutcome }): Recorded {
    const healed: string[] = [];
    const notices: Notice[] = [];
    const prompts: ((yes: boolean) => void)[] = [];
    let started = 0;
    const seams: FarmHealSeams = {
        heal: (analysisId) => {
            const outcome = over.outcome ?? { kind: "composed", packages: 2 };
            if (outcome.kind === "composed" || outcome.kind === "failed") healed.push(analysisId);
            return okAsync({ outcome });
        },
        liveCatalogTransfer: () => false,
        confirmDownload: (onAnswer) => {
            prompts.push(onAnswer);
        },
        startDownload: async () => {
            started += 1;
        },
        notify: (notice) => notices.push(notice),
        ...over,
    };
    return { seams, healed, notices, prompts, started: () => started };
}

/** Mount `watchFarmHeal` in a disposable reactive root; returns the dispose. */
function mount(ws: Workspace, seams: FarmHealSeams): () => void {
    let dispose = (): void => {};
    createRoot((d) => {
        dispose = d;
        watchFarmHeal(ws, seams);
    });
    return dispose;
}

/** Let the async heal decision settle. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

afterEach(() => {
    __resetFarmHealForTest();
    __resetSandboxGateForTest();
});

describe("watchFarmHeal — the open trigger", () => {
    test("a farm-less analysis heals full when the catalog is present", async () => {
        const { seams, healed, notices } = recordedSeams({});
        const dispose = mount(wsWith(ANALYSIS), seams);
        await settle();

        expect(healed).toEqual(["a1"]);
        expect(notices.some((notice) => notice.kind === "info" && notice.text.includes("2 packages"))).toBe(true);
        dispose();
    });

    test("a present farm stays untouched: no heal, and no prompt", async () => {
        const { seams, healed, prompts } = recordedSeams({ outcome: { kind: "already_present" } });
        const dispose = mount(wsWith(ANALYSIS), seams);
        await settle();

        expect(healed).toEqual([]);
        expect(prompts).toHaveLength(0);
        dispose();
    });

    test("a heal failure surfaces its reason", async () => {
        const { seams, notices } = recordedSeams({
            outcome: { kind: "failed", reason: "another process (pid 7) composes this farm right now" },
        });
        const dispose = mount(wsWith(ANALYSIS), seams);
        await settle();

        expect(notices.some((notice) => notice.kind === "error" && notice.text.includes("could not be composed"))).toBe(true);
        dispose();
    });

    test("a live catalog transfer defers to the landing: no heal, and no prompt", async () => {
        const { seams, healed, prompts } = recordedSeams({ outcome: { kind: "no_catalog" }, liveCatalogTransfer: () => true });
        const dispose = mount(wsWith(ANALYSIS), seams);
        await settle();

        expect(healed).toEqual([]);
        expect(prompts).toHaveLength(0);
        dispose();
    });

    test("no catalog and no live transfer prompts for the download, with one consent", async () => {
        const { seams, prompts, started } = recordedSeams({ outcome: { kind: "no_catalog" } });
        const dispose = mount(wsWith(ANALYSIS), seams);
        await settle();

        expect(prompts).toHaveLength(1);
        prompts[0]!(true);
        await settle();
        expect(started()).toBe(1);

        // The consent was given once. A second mount of the same analysis asks nothing again.
        const again = mount(wsWith(ANALYSIS), seams);
        await settle();
        expect(prompts).toHaveLength(1);
        dispose();
        again();
    });

    test("a declined prompt starts nothing", async () => {
        const { seams, prompts, started } = recordedSeams({ outcome: { kind: "no_catalog" } });
        const dispose = mount(wsWith(ANALYSIS), seams);
        await settle();

        prompts[0]!(false);
        await settle();
        expect(started()).toBe(0);
        dispose();
    });
});

describe("watchFarmHeal — the landing trigger", () => {
    test("the catalog landing runs the heal for the open farm-less analysis", async () => {
        let present = false;
        const healed: string[] = [];
        const { seams } = recordedSeams({
            // The route composes once the catalog is present, and reports no catalog before.
            heal: (analysisId) => {
                if (!present) return okAsync({ outcome: { kind: "no_catalog" } });
                healed.push(analysisId);
                return okAsync({ outcome: { kind: "composed", packages: 2 } });
            },
            liveCatalogTransfer: () => true,
        });
        const dispose = mount(wsWith(ANALYSIS), seams);
        await settle();
        expect(healed).toEqual([]);

        // The poll observes the live transfer, then the landing.
        __setTransferReportsForTest([catalogReport("running", true)]);
        await settle();
        present = true;
        __setTransferReportsForTest([catalogReport("installed", false)]);
        await settle();

        expect(healed).toEqual(["a1"]);
        dispose();
    });
});
