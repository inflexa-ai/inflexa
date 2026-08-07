import { afterEach, describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import type { LibStoreDownloadError, LibStoreDownloadOutcome, LibStoreDownloadState } from "../../modules/libs/store_download.ts";
import type { Notice } from "../theme.ts";
import {
    awaitSandboxReady,
    libStoreGateState,
    startLibStoreDownload,
    type ImageReadiness,
    type SandboxGateSeams,
    __resetSandboxGateForTest,
} from "./sandbox_gate.tsx";

// The gate flow runs offline: the store reads, the engine image checks, the consent dialog, and the
// notice channel are all injected as stubs. The facts under test are the gate holding a sandbox action
// until the store is complete (with a visible state), NO state in which it passes without a store, an
// unusable store refusing the action with its remedy, and the app-open trigger asking before it applies a
// moved-tag update.

afterEach(() => __resetSandboxGateForTest());

const STORE_ROOT = "/tmp/store";
const INVENTORY = `${STORE_ROOT}/current/packages.txt`;
const DOWNLOADED: LibStoreDownloadOutcome = {
    type: "downloaded",
    manifestDigest: "sha256:a",
    bytes: 100,
    merge: { storeDirsAdded: [], farmsAdded: [], farmsKept: [], currentSet: false },
};
const UPDATE_AVAILABLE: LibStoreDownloadOutcome = { type: "update_available", installedDigest: "sha256:a", latestDigest: "sha256:b" };
const DOWNLOAD_ERROR: LibStoreDownloadError = { type: "download_failed", message: "the layer did not arrive." };

/** A recording of what the stubbed seams saw, for the flow assertions. */
type Recorder = {
    readonly confirms: string[];
    /** The body of each ask, so a test reads the wording the user meets. */
    readonly confirmMessages: string[];
    readonly downloads: { force: boolean }[];
    readonly notices: Notice[];
    imageChecks: number;
    pulls: number;
};

type SeamOverrides = {
    readonly inspect?: LibStoreDownloadState;
    /** The active farm's inventory path, or `null` for a store no sandbox could mount. */
    readonly inventory?: string | null;
    /** Answered in order; a shortfall defaults to `true`. */
    readonly confirmAnswers?: boolean[];
    /** Produce the download result for one call, keyed on `force`. */
    readonly download?: (force: boolean) => Result<LibStoreDownloadOutcome, LibStoreDownloadError>;
    /** Run before the download resolves, to model an in-flight transfer. */
    readonly onDownload?: () => Promise<void>;
    readonly image?: ImageReadiness;
    readonly pull?: Result<void, { message: string }>;
};

function makeSeams(over: SeamOverrides = {}): { seams: SandboxGateSeams; rec: Recorder } {
    const rec: Recorder = { confirms: [], confirmMessages: [], downloads: [], notices: [], imageChecks: 0, pulls: 0 };
    const answers = [...(over.confirmAnswers ?? [])];
    const seams: SandboxGateSeams = {
        storeRoot: () => STORE_ROOT,
        inspect: async () => over.inspect ?? "missing",
        download: async (_root, force) => {
            rec.downloads.push({ force });
            if (over.onDownload) await over.onDownload();
            return over.download ? over.download(force) : ok(DOWNLOADED);
        },
        storeInventory: () => (over.inventory === undefined ? INVENTORY : over.inventory),
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
            rec.confirmMessages.push(opts.message);
            return answers.shift() ?? true;
        },
        notify: (notice) => void rec.notices.push(notice),
    };
    return { seams, rec };
}

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("awaitSandboxReady — the store half of the gate", () => {
    // The whole point of removing the opt-in: there is no configuration, and no phase, that lets a
    // sandbox action through while the store is absent. Every state a store with no content can be in
    // ends in `blocked`.
    test("the gate has no state that passes without a store", async () => {
        for (const inspect of ["missing", "incomplete", "invalid_receipt"] as const) {
            __resetSandboxGateForTest();
            const { seams, rec } = makeSeams({ inspect, confirmAnswers: [false] });
            expect(await awaitSandboxReady(seams)).toBe("blocked");
            // Refused before the image half, so nothing downstream can start a sandbox either.
            expect(rec.imageChecks).toBe(0);
        }
    });

    test("a sandbox action holds during the download with a visible state, then proceeds", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const { seams, rec } = makeSeams({ inspect: "missing", onDownload: () => gate });

        const pending = awaitSandboxReady(seams);
        let settled: "ready" | "blocked" | undefined;
        void pending.then((v) => {
            settled = v;
        });
        await tick();

        // The consent was accepted and the download is in flight: the gate holds, the state is visible.
        expect(rec.confirms).toEqual(["Download the package store?"]);
        expect(libStoreGateState().phase).toBe("downloading");
        expect(rec.notices.some((n) => n.text.startsWith("Downloading the package store"))).toBe(true);
        expect(settled).toBeUndefined();

        release();
        expect(await pending).toBe("ready");
        expect(libStoreGateState().phase).toBe("installed");
    });

    test("no sandbox starts against an empty store: a declined consent blocks and downloads nothing", async () => {
        const { seams, rec } = makeSeams({ inspect: "missing", confirmAnswers: [false] });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(rec.downloads).toEqual([]);
        expect(libStoreGateState().phase).toBe("declined");
    });

    test("an unreadable inventory refuses the action, names the remedy, and starts no sandbox", async () => {
        // The bytes are all there — the receipt says installed — but the active farm carries no inventory,
        // so a sandbox launched now could import nothing. There is no second source to degrade onto.
        const { seams, rec } = makeSeams({ inspect: "installed", inventory: null });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("failed");
        expect(rec.imageChecks).toBe(0);
        const failure = rec.notices.find((n) => n.kind === "error");
        expect(failure?.text).toContain("inflexa store use");
    });

    test("a completed download whose farm is unusable still refuses", async () => {
        const { seams } = makeSeams({ inspect: "missing", inventory: null });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("failed");
    });

    test("a locally built store gets the merge consent, not the plain install offer", async () => {
        const { seams, rec } = makeSeams({ inspect: "local" });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        // The ask names the merge, so a user with provisioned packages is not offered a plain install.
        expect(rec.confirmMessages[0]).toContain("adds to the store you have");
        expect(rec.confirmMessages[0]).toContain("keeps every package and farm");
    });

    test("an empty store gets the plain install consent", async () => {
        const { seams, rec } = makeSeams({ inspect: "missing" });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.confirmMessages[0]).toContain("one-time download");
        expect(rec.confirmMessages[0]).not.toContain("adds to the store you have");
    });

    test("an installed store passes at once, with no network and no consent", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed" });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.downloads).toEqual([]);
        expect(rec.confirms).toEqual([]);
    });

    test("a failed download leaves chat usable, offers a retry at the next action, and starts no sandbox", async () => {
        // First arrival: consent accepted, but the download fails, so the gate blocks and records the state.
        let downloadCalls = 0;
        const { seams, rec } = makeSeams({
            inspect: "incomplete",
            confirmAnswers: [true, true],
            download: () => {
                downloadCalls += 1;
                return downloadCalls === 1 ? err(DOWNLOAD_ERROR) : ok(DOWNLOADED);
            },
        });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(libStoreGateState().phase).toBe("failed");
        expect(rec.notices.some((n) => n.kind === "error")).toBe(true);
        // The failure stopped at the store half: no image was checked and no sandbox could follow.
        expect(rec.imageChecks).toBe(0);

        // Second arrival: the failure is reported again and a retry is offered; the retry succeeds.
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.confirms).toEqual(["Download the package store?", "Retry the package store download?"]);
        expect(libStoreGateState().phase).toBe("installed");
    });

    test("a download that adds a farm without moving the pointer names the switch command", async () => {
        const { seams, rec } = makeSeams({
            inspect: "missing",
            download: () => ok({ ...DOWNLOADED, merge: { storeDirsAdded: [], farmsAdded: ["catalog"], farmsKept: ["default"], currentSet: false } }),
        });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.notices.some((n) => n.text.includes("inflexa store use catalog"))).toBe(true);
    });

    test("a download that set the pointer itself suggests no switch", async () => {
        const { seams, rec } = makeSeams({
            inspect: "missing",
            download: () => ok({ ...DOWNLOADED, merge: { storeDirsAdded: [], farmsAdded: ["catalog"], farmsKept: [], currentSet: true } }),
        });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.notices.some((n) => n.text.includes("inflexa store use"))).toBe(false);
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

describe("startLibStoreDownload — the app-open trigger", () => {
    // The first run: a machine with no store and no receipt. The app opens at once (the trigger never
    // blocks anything), the consent opens ONE time, and the first sandbox action holds on the same flow.
    test("the first run opens the consent once, and the first sandbox action holds on that same download", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const { seams, rec } = makeSeams({ inspect: "missing", onDownload: () => gate });

        const opening = startLibStoreDownload(seams);
        await tick();
        expect(rec.confirms).toEqual(["Download the package store?"]);
        expect(libStoreGateState().phase).toBe("downloading");

        // The sandbox action arrives while that download runs: it holds, and it asks nothing again.
        const action = awaitSandboxReady(seams);
        let settled: "ready" | "blocked" | undefined;
        void action.then((v) => {
            settled = v;
        });
        await tick();
        expect(settled).toBeUndefined();
        expect(rec.confirms).toEqual(["Download the package store?"]);
        expect(rec.downloads).toEqual([{ force: false }]);
        // The byte total is what the status surface reports while the hold lasts.
        const phase = libStoreGateState();
        expect(phase.phase).toBe("downloading");
        if (phase.phase === "downloading") expect(phase.bytes).toBe(0);

        release();
        await opening;
        expect(await action).toBe("ready");
    });

    test("app open never pulls the image, so chat is usable while the image is absent", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", download: () => ok({ type: "up_to_date", manifestDigest: "sha256:a" }) });
        await startLibStoreDownload(seams);
        // The trigger checks the store only; the image is left to the first sandbox action.
        expect(rec.imageChecks).toBe(0);
        expect(rec.pulls).toBe(0);
    });

    test("a moved tag asks before it applies, and passes force only after the yes", async () => {
        const { seams, rec } = makeSeams({
            inspect: "installed",
            confirmAnswers: [true],
            download: (force) => (force ? ok(DOWNLOADED) : ok(UPDATE_AVAILABLE)),
        });
        await startLibStoreDownload(seams);
        // The check (no force) reported the update; the second download applied it with force.
        expect(rec.downloads).toEqual([{ force: false }, { force: true }]);
        expect(rec.confirms).toEqual(["Update the package store?"]);
    });

    test("a declined update downloads nothing more", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed", confirmAnswers: [false], download: () => ok(UPDATE_AVAILABLE) });
        await startLibStoreDownload(seams);
        expect(rec.downloads).toEqual([{ force: false }]);
    });
});
