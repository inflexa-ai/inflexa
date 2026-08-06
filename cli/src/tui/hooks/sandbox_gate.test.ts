import { afterEach, describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import type { LibStoreLocation } from "../../modules/harness/config.ts";
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
// notice channel are all injected as stubs. The two facts under test are the gate holding a sandbox
// action until the store is complete (with a visible state), and no sandbox proceeding against an empty
// store — plus the app-open trigger asking before it applies a moved-tag update.

afterEach(() => __resetSandboxGateForTest());

const CONFIGURED: LibStoreLocation = { configured: true, path: "/tmp/store" };
const DOWNLOADED: LibStoreDownloadOutcome = { type: "downloaded", manifestDigest: "sha256:a", bytes: 100 };
const UPDATE_AVAILABLE: LibStoreDownloadOutcome = { type: "update_available", installedDigest: "sha256:a", latestDigest: "sha256:b" };
const DOWNLOAD_ERROR: LibStoreDownloadError = { type: "download_failed", message: "the layer did not arrive." };

/** A recording of what the stubbed seams saw, for the flow assertions. */
type Recorder = {
    readonly confirms: string[];
    readonly downloads: { force: boolean }[];
    readonly notices: Notice[];
    imageChecks: number;
    pulls: number;
};

type SeamOverrides = {
    readonly location?: LibStoreLocation;
    readonly inspect?: LibStoreDownloadState;
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
    const rec: Recorder = { confirms: [], downloads: [], notices: [], imageChecks: 0, pulls: 0 };
    const answers = [...(over.confirmAnswers ?? [])];
    const seams: SandboxGateSeams = {
        resolveLocation: () => over.location ?? CONFIGURED,
        inspect: async () => over.inspect ?? "missing",
        download: async (_location, force) => {
            rec.downloads.push({ force });
            if (over.onDownload) await over.onDownload();
            return over.download ? over.download(force) : ok(DOWNLOADED);
        },
        sandboxImage: () => "ghcr.io/inflexa-ai/sandbox-python-r:latest",
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
    };
    return { seams, rec };
}

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("awaitSandboxReady — the store half of the gate", () => {
    test("no store configured: the gate passes the store silently and only the image applies", async () => {
        const { seams, rec } = makeSeams({ location: { configured: false } });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        // The network and the consent were never touched; the image was still checked.
        expect(rec.downloads).toEqual([]);
        expect(rec.confirms).toEqual([]);
        expect(rec.imageChecks).toBe(1);
        expect(libStoreGateState().phase).toBe("unconfigured");
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

    test("an installed store passes at once, with no network and no consent", async () => {
        const { seams, rec } = makeSeams({ inspect: "installed" });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.downloads).toEqual([]);
        expect(rec.confirms).toEqual([]);
    });

    test("a failed download reports at the gate with a retry, and never holds without end", async () => {
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

        // Second arrival: the failure is reported again and a retry is offered; the retry succeeds.
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.confirms).toEqual(["Download the package store?", "Retry the package store download?"]);
        expect(libStoreGateState().phase).toBe("installed");
    });
});

describe("awaitSandboxReady — the image half of the gate", () => {
    test("a pullable image is pulled after consent, then the gate is ready", async () => {
        const { seams, rec } = makeSeams({ location: { configured: false }, image: { kind: "pullable", variant: "python-r" } });
        expect(await awaitSandboxReady(seams)).toBe("ready");
        expect(rec.pulls).toBe(1);
    });

    test("a declined image pull blocks and pulls nothing", async () => {
        const { seams, rec } = makeSeams({ location: { configured: false }, image: { kind: "pullable", variant: "python" }, confirmAnswers: [false] });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(rec.pulls).toBe(0);
        expect(rec.notices.some((n) => n.kind === "warn")).toBe(true);
    });

    test("an engine error blocks and names the fault", async () => {
        const { seams, rec } = makeSeams({ location: { configured: false }, image: { kind: "engine_error", message: "the Podman machine is not running." } });
        expect(await awaitSandboxReady(seams)).toBe("blocked");
        expect(rec.notices.some((n) => n.kind === "error" && n.text.includes("Podman"))).toBe(true);
    });
});

describe("startLibStoreDownload — the app-open trigger", () => {
    test("no store configured: a clean no-op that touches no network and no image", async () => {
        const { seams, rec } = makeSeams({ location: { configured: false } });
        await startLibStoreDownload(seams);
        expect(rec.downloads).toEqual([]);
        expect(rec.confirms).toEqual([]);
        expect(rec.imageChecks).toBe(0);
        expect(libStoreGateState().phase).toBe("unconfigured");
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
