import { afterEach, describe, expect, test } from "bun:test";
import { ok, type Result } from "neverthrow";

import type { LibStoreDownloadReport, LibStoreDownloadRow, LibStoreDownloadState, LibStoreDownloadStatus } from "../../modules/libs/store_download.ts";
import type { FarmCompositionFailure } from "../../modules/libs/composition.ts";
import type { LibStoreFlightReport } from "../../modules/libs/store_flight.ts";
import type { Notice } from "../theme.ts";
import {
    awaitSandboxReady,
    libStoreFlights,
    libStoreGateState,
    refreshLibStoreGateState,
    type ImageReadiness,
    type SandboxGateSeams,
    __resetSandboxGateForTest,
} from "./sandbox_gate.tsx";

// The gate flow runs offline: the store reads, the lifecycle row, the engine image checks, the consent
// dialog, and the notice channel are all injected as stubs. The facts under test are the app starting NO
// download, the gate holding a sandbox action while the detached transfer runs (with a visible state),
// NO state in which it passes without a store, the filesystem deciding usability, and each terminal state
// refusing with a named retry and no consent.

afterEach(() => __resetSandboxGateForTest());

const STORE_ROOT = "/tmp/store";
const INVENTORY = `${STORE_ROOT}/packages.txt`;

/** A row in one state, with the counters a live transfer would have written. */
function row(state: LibStoreDownloadStatus, over: Partial<LibStoreDownloadRow> = {}): LibStoreDownloadRow {
    return {
        id: "lib-store-download",
        createdAt: 1,
        updatedAt: 2,
        state,
        bytesTransferred: 0,
        totalBytes: null,
        layersCompleted: 0,
        totalLayers: null,
        manifestDigest: null,
        message: null,
        holderPid: null,
        ...over,
    };
}

/** A recording of what the stubbed seams saw, for the flow assertions. */
type Recorder = {
    readonly confirms: string[];
    readonly notices: Notice[];
    /** Every read of the lifecycle row, so a test proves the gate reads and never writes. */
    downloadReads: number;
    imageChecks: number;
    pulls: number;
    /** Every read of the composition-failure record, so a test proves that the gate consumes it one time. */
    farmReads: number;
};

type SeamOverrides = {
    readonly inspect?: LibStoreDownloadState;
    /** The pool inventory path of the store, or `null` for a store no sandbox could mount. */
    readonly inventory?: string | null;
    /** The farm composition that failed and that nothing reported yet. `null` is the ordinary state. */
    readonly farmFailure?: FarmCompositionFailure | null;
    /** The lifecycle reports, consumed in order; the last one repeats once the list runs out. */
    readonly reports?: LibStoreDownloadReport[];
    /** The manifest digest the receipt pins. */
    readonly installedManifest?: string | null;
    /** Answered in order; a shortfall defaults to `true`. */
    readonly confirmAnswers?: boolean[];
    readonly image?: ImageReadiness;
    readonly pull?: Result<void, { message: string }>;
    /** The acquisition flights that are live. They decide nothing at the gate; they only publish. */
    readonly flights?: readonly LibStoreFlightReport[];
};

/** A report with no row at all: the machine on which no download ever ran. */
const NO_ROW: LibStoreDownloadReport = { row: null, state: null, live: false, holderPid: null };

/** A live transfer, which is a `running` row whose holder is alive. */
function liveReport(over: Partial<LibStoreDownloadRow> = {}): LibStoreDownloadReport {
    return { row: row("running", { holderPid: 4242, ...over }), state: "running", live: true, holderPid: 4242 };
}

/** A settled report: the row in a terminal state, with nothing holding the lock. */
function settledReport(state: LibStoreDownloadStatus, over: Partial<LibStoreDownloadRow> = {}): LibStoreDownloadReport {
    return { row: row(state, over), state, live: false, holderPid: null };
}

function makeSeams(over: SeamOverrides = {}): { seams: SandboxGateSeams; rec: Recorder } {
    const rec: Recorder = { confirms: [], notices: [], downloadReads: 0, imageChecks: 0, pulls: 0, farmReads: 0 };
    const answers = [...(over.confirmAnswers ?? [])];
    const reports = [...(over.reports ?? [NO_ROW])];
    const seams: SandboxGateSeams = {
        storeRoot: () => STORE_ROOT,
        inspect: async () => over.inspect ?? "missing",
        readDownload: () => {
            rec.downloadReads += 1;
            return reports.length > 1 ? (reports.shift() ?? NO_ROW) : (reports[0] ?? NO_ROW);
        },
        readFlights: () => over.flights ?? [],
        installedManifest: async () => over.installedManifest ?? null,
        storeInventory: () => (over.inventory === undefined ? INVENTORY : over.inventory),
        takeFarmFailure: () => {
            // The real seam consumes, thus a second read inside one flow answers `null` exactly as it does.
            rec.farmReads += 1;
            return rec.farmReads === 1 ? (over.farmFailure ?? null) : null;
        },
        sandboxImage: () => "ghcr.io/inflexa-ai/sandbox-base:latest",
        imageReadiness: async () => {
            rec.imageChecks += 1;
            return over.image ?? { kind: "present" };
        },
        pullImage: async () => {
            rec.pulls += 1;
            return over.pull ?? ok(undefined);
        },
        confirm: async (opts) => {
            rec.confirms.push(opts.title);
            return answers.shift() ?? true;
        },
        notify: (notice) => void rec.notices.push(notice),
        // A real delay would make each polled test spend the production cadence; the flow is identical.
        pollMs: 1,
    };
    return { seams, rec };
}

describe("the gate reads the detached download and starts none", () => {
    // The whole point of the detachment: the app is a reader. No state of the gate spawns a process, and
    // no state of the gate opens a consent about the catalog.
    test("no store and no live downloader: the app reports the absence and starts nothing", async () => {
        const { seams, rec } = makeSeams({ inspect: "missing", reports: [NO_ROW] });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("absent");
        expect(rec.confirms).toEqual([]);
        // Refused before the image half, so nothing downstream can start a sandbox either.
        expect(rec.imageChecks).toBe(0);
    });

    test("the gate has no state that passes without a store", async () => {
        for (const inspect of ["missing", "incomplete", "invalid_receipt", "local"] as const) {
            __resetSandboxGateForTest();
            const { seams, rec } = makeSeams({ inspect, reports: [settledReport("failed", { message: "the layer did not arrive." })] });
            expect(await awaitSandboxReady(seams)).toBe("blocked");
            expect(rec.imageChecks).toBe(0);
        }
    });

    test("an installed row over an absent receipt keeps the refusal, because the filesystem decides", async () => {
        const { seams, rec } = makeSeams({ inspect: "missing", reports: [settledReport("installed")] });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("failed");
        expect(rec.imageChecks).toBe(0);
    });

    test("a valid receipt with NO row is usable, and the absent row changes nothing", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", reports: [NO_ROW] });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(libStoreGateState().phase).toBe("installed");
        expect(rec.confirms).toEqual([]);
    });

    test("an installed row and a valid receipt release the hold", async () => {
        // The transfer is live at the first read and installed at the second: the hold ends exactly when
        // the row settles, and the receipt is what lets it through.
        let inspected = 0;
        const { seams } = makeSeams({ reports: [liveReport(), settledReport("installed")] });
        const staged: SandboxGateSeams = {
            ...seams,
            inspect: async () => {
                inspected += 1;
                return inspected === 1 ? "incomplete" : "installed";
            },
        };
        expect(await awaitSandboxReady(staged)).toBe("ready");
        expect(libStoreGateState().phase).toBe("installed");
    });

    test("a dead downloader refuses rather than holding without end", async () => {
        // The report already degrades a `running` row with no live holder to `failed`; the gate must act on
        // that corrected state and not on the raw row.
        const { seams, rec } = makeSeams({
            reports: [{ row: row("running", { holderPid: 4242 }), state: "failed", live: false, holderPid: null }],
        });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("failed");
        expect(rec.imageChecks).toBe(0);
    });

    test("a declined state refuses, names the retry, and opens no consent", async () => {
        const { seams, rec } = makeSeams({ reports: [settledReport("declined")] });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("declined");
        expect(rec.confirms).toEqual([]);
        expect(rec.notices.some((n) => n.text.includes("inflexa store download"))).toBe(true);
    });

    test("a canceled state refuses, names the retry, and opens no consent", async () => {
        const { seams, rec } = makeSeams({ reports: [settledReport("canceled")] });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("canceled");
        expect(rec.confirms).toEqual([]);
        expect(rec.notices.some((n) => n.text.includes("inflexa store download"))).toBe(true);
    });

    test("a failed state reports the message of the row and names the retry", async () => {
        const { seams, rec } = makeSeams({
            reports: [settledReport("failed", { message: "The disk ran out. Free 3.0 GiB, then run `inflexa store download`." })],
        });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        const state = libStoreGateState();
        expect(state.phase).toBe("failed");
        if (state.phase === "failed") expect(state.message).toContain("The disk ran out");
        expect(rec.notices.some((n) => n.kind === "error" && n.text.includes("The disk ran out"))).toBe(true);
    });

    test("the hold text carries no meter and no percentage", async () => {
        // The transfer is live at the first read and failed at the second, so the hold ends rather than
        // polling for ever — the wait is bounded by the transfer itself, never by a clock.
        const { seams, rec } = makeSeams({
            reports: [liveReport({ bytesTransferred: 512, totalBytes: 1024 }), settledReport("failed", { message: "the layer did not arrive." })],
        });
        expect(await awaitSandboxReady(seams)).toBe("blocked");

        const hold = rec.notices.find((notice) => notice.text.includes("downloading"));
        expect(hold).toBeDefined();
        expect(hold?.text).not.toContain("%");
        // U+25AE is the meter cell of the design system. The sidebar owns it, and two surfaces must not
        // show one figure.
        expect(hold?.text).not.toContain("\u25ae");
    });
});

describe("refreshLibStoreGateState — the row reader", () => {
    test("a live transfer publishes its running counts and the totals the manifest declared", async () => {
        const { seams } = makeSeams({ reports: [liveReport({ bytesTransferred: 300, totalBytes: 900, layersCompleted: 1, totalLayers: 3 })] });
        const state = await refreshLibStoreGateState(seams);
        expect(state).toEqual({ phase: "downloading", bytes: 300, totalBytes: 900, layers: 1, totalLayers: 3 });
    });

    test("the totals stay absent before the manifest resolves, and no estimate is invented", async () => {
        const { seams } = makeSeams({ reports: [liveReport({ bytesTransferred: 0 })] });
        const state = await refreshLibStoreGateState(seams);
        expect(state.phase).toBe("downloading");
        if (state.phase === "downloading") {
            expect(state.totalBytes).toBeNull();
            expect(state.totalLayers).toBeNull();
        }
    });

    test("a receipt that pins the resolved manifest reports no available update", async () => {
        const { seams } = makeSeams({
            inspect: "installed",
            reports: [settledReport("installed", { manifestDigest: "sha256:a" })],
            installedManifest: "sha256:a",
        });
        expect(await refreshLibStoreGateState(seams)).toEqual({ phase: "installed", updateAvailable: false });
    });

    test("a receipt that pins a different manifest reports an available update", async () => {
        const { seams } = makeSeams({
            inspect: "installed",
            reports: [settledReport("installed", { manifestDigest: "sha256:b" })],
            installedManifest: "sha256:a",
        });
        expect(await refreshLibStoreGateState(seams)).toEqual({ phase: "installed", updateAvailable: true });
    });

    test("a store with no row reports no available update, because nothing resolved a manifest", async () => {
        const { seams } = makeSeams({ inspect: "installed", reports: [NO_ROW] });
        expect(await refreshLibStoreGateState(seams)).toEqual({ phase: "installed", updateAvailable: false });
    });
});

describe("awaitSandboxReady — the image half of the gate", () => {
    test("a pullable image is pulled after consent, then the gate is ready", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", image: { kind: "pullable" } });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.pulls).toBe(1);
    });

    test("a declined image pull blocks and pulls nothing", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", image: { kind: "pullable" }, confirmAnswers: [false] });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(rec.pulls).toBe(0);
        expect(rec.notices.some((n) => n.kind === "warn")).toBe(true);
    });

    test("an engine error blocks and names the fault", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", image: { kind: "engine_error", message: "the Podman machine is not running." } });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(rec.notices.some((n) => n.kind === "error" && n.text.includes("Podman"))).toBe(true);
    });
});

describe("the farm half of the gate — the composition failure the provider recorded", () => {
    // Composition runs INSIDE the farm provider the harness calls, thus it runs after this gate decided
    // and its error reaches no user surface of its own. The provider records the reason, and the gate is
    // where the user reads it.

    test("a recorded failure blocks the action and names the reason", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", farmFailure: { analysisId: "an-1", reason: "the catalog template farm is absent" } });

        expect(await awaitSandboxReady(seams)).toBe("blocked");

        expect(rec.notices.some((n) => n.kind === "error" && n.text.includes("the catalog template farm is absent"))).toBe(true);
        // The image half never ran: a farm that cannot compose refuses the sandbox whatever the image does,
        // and the image half can open a multi-gigabyte pull consent.
        expect(rec.imageChecks).toBe(0);
        expect(rec.pulls).toBe(0);
    });

    test("the report consumes the record, thus the next action composes again", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", farmFailure: { analysisId: "an-1", reason: "a dangling edge" } });
        expect(await awaitSandboxReady(seams)).toBe("blocked");

        // A gate that held the record would refuse for ever: the composition that clears it is exactly what
        // the refusal stops.
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.farmReads).toBe(2);
    });

    test("no recorded failure changes nothing, which is the ordinary state", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed" });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.notices).toEqual([]);
    });
});

describe("the acquisition flights the rail renders", () => {
    // A flight decides NOTHING at the gate: the store is usable while a package acquires into it, thus a
    // live flight must not change the phase and must not hold a sandbox action.
    test("a live flight publishes its line and leaves the gate verdict alone", async () => {
        const { seams } = makeSeams({
            inspect: "installed",
            flights: [
                {
                    row: {
                        id: "python scanpy>=1.9",
                        createdAt: 1,
                        updatedAt: 2,
                        state: "running",
                        ecosystem: "python",
                        name: "scanpy",
                        specifier: ">=1.9",
                        progress: "[provision] resolving",
                        holderPid: 4242,
                    },
                    analysisIds: ["a1", "a2"],
                },
            ],
        });

        expect(await refreshLibStoreGateState(seams)).toEqual({ phase: "installed", updateAvailable: false });
        expect(libStoreFlights()).toEqual([{ spec: "python scanpy>=1.9", state: "running", progress: "[provision] resolving", subscribers: 2 }]);
        // The gate still passes, because a flight is work in progress and never a fault of the store.
        expect(await awaitSandboxReady(seams)).toBe("ready");
    });

    test("no flight publishes no line, thus the rail takes no height for it", async () => {
        const { seams } = makeSeams({ inspect: "installed" });
        await refreshLibStoreGateState(seams);
        expect(libStoreFlights()).toEqual([]);
    });
});
