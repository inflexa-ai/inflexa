/**
 * The detached transfer lifecycle that the three transfer kinds share: the
 * runtime image, the provisioner image, and the catalog.
 *
 * Each transfer runs as ONE detached child process — a re-invocation of this
 * CLI with a hidden flag, with ignored stdio and `unref`. The child outlives
 * the command and the app that started it. Each transfer owns one database row
 * with its state, its byte totals, and its failure message, and one instance
 * lock gives its liveness: the child holds the lock for its whole life, thus a
 * `running` row with no live holder reads as `failed`. A killed child writes no
 * failure row, and the lock is the one sound signal that needs no heartbeat and
 * no clock.
 *
 * This module owns the LIFECYCLE: the kinds, the reports, the spawn, the image
 * child bodies, and the stop of a live child. The catalog MECHANICS — the OCI
 * resolve, the blob cache, the merge, and the receipt — live in
 * `store_download.ts`, which writes the same `catalog` row through the same
 * database helpers. The two never import each other in a cycle: the dispatch
 * from the hidden flag to a child body lives in the command actions.
 */

import { join } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { ensureRuntime } from "../../lib/config.ts";
import { capture, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { acquireInstanceLock, instanceLockHolder, releaseInstanceLock, TRANSFER_LOCK_KEY_PREFIX } from "../../lib/lock.ts";
import { getTransfer, listTransfers } from "../../db/primary_query.ts";
import { recordTransferResolve, settleTransfer, startTransferRun } from "../../db/primary_mutation.ts";
import { provisionerImageFor } from "./images.ts";
import { imagePackagesFile } from "./packages.ts";
import { configuredSandboxImage } from "./pull.ts";

/** The three transfer kinds, in the order the surfaces render them. */
export const TRANSFER_KINDS = ["runtime_image", "provisioner_image", "catalog"] as const;

/** One of the three transfer kinds. */
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/**
 * The lifecycle states of one transfer.
 *
 * `declined` records a setup answer of no, which starts no child and writes no
 * staged tree. `canceled` records a transfer that started and that the user
 * stopped. The difference is load-bearing: only the second has a partial tree
 * to drop. `failed`, `declined`, and `canceled` are terminal, and only a retry
 * leaves one of them.
 */
export type TransferStatus = "pending" | "running" | "installed" | "failed" | "declined" | "canceled";

/**
 * The one persisted row of a transfer kind.
 *
 * The row is the truth of what the CHILD does, and it decides nothing about
 * usability: an image or a store can arrive by a route that wrote no row, thus
 * an absent row is a normal condition. The receipt on disk (catalog) and the
 * engine (images) stay the truth of what the machine holds.
 *
 * The shape lives beside the lifecycle rather than in `src/types/`, because the
 * transfers are its one consumer. `src/db/` takes it as a type-only import,
 * thus the storage layer keeps no runtime dependency on this module.
 */
export type TransferRow = {
    /** The kind, which is the whole identity of the row — one row per kind. */
    readonly id: TransferKind;
    /** When the first run wrote the row, epoch millis. */
    readonly createdAt: number;
    /** When the last write landed, epoch millis. */
    readonly updatedAt: number;
    /** The lifecycle state as WRITTEN. Read it through {@link readTransferReport}, which corrects a dead holder. */
    readonly state: TransferStatus;
    /** The bytes the transfer has moved so far. Zero for an image pull, whose engine reports no byte figure. */
    readonly bytesTransferred: number;
    /** The bytes the source declares, or `null` when it declares none. */
    readonly totalBytes: number | null;
    /** The layers the transfer has completed so far. */
    readonly layersCompleted: number;
    /** The layers the source declares, or `null` when it declares none. */
    readonly totalLayers: number | null;
    /** What the last resolve saw: a manifest digest for the catalog, a local image digest for an image. */
    readonly digest: string | null;
    /** The user-facing message of a failure, or the notice of a completed run. Never a stack trace. */
    readonly message: string | null;
    /** The process identifier of the child, or `null` when no child holds the run. */
    readonly holderPid: number | null;
};

/** The instance-lock key of one transfer kind. The child holds it for its whole life. */
export function transferLockKey(kind: TransferKind): string {
    return `${TRANSFER_LOCK_KEY_PREFIX}${kind}`;
}

/** The lifecycle of one transfer kind, as any reader must act on it. */
export type TransferReport = {
    readonly kind: TransferKind;
    /** The row as it stands, or `null` when no transfer of this kind ever ran. */
    readonly row: TransferRow | null;
    /**
     * The state a reader acts on, which is NOT always `row.state`. A row that
     * reports `running` with no live holder reads as `failed`. `null` means that
     * no transfer ran.
     */
    readonly state: TransferStatus | null;
    /** True while a child holds the lock. A second start yields to it, and the gate waits on it. */
    readonly live: boolean;
    /** The pid of the live child, or `null`. A cancel signals exactly this process. */
    readonly holderPid: number | null;
};

/**
 * Read the lifecycle of one transfer kind: the row, corrected by the liveness
 * of the lock holder.
 *
 * A read failure degrades to "no transfer ran" rather than an error. The
 * database is a file on the machine of the user, and a machine whose images and
 * store are present is usable whatever this row says — a hard failure here
 * would refuse a machine that works.
 */
export function readTransferReport(kind: TransferKind): TransferReport {
    const holderPid = instanceLockHolder(transferLockKey(kind));
    const row = getTransfer(kind).unwrapOr(null);
    if (row === null) return { kind, row: null, state: null, live: false, holderPid };
    const started = row.state === "pending" || row.state === "running";
    const live = started && holderPid !== null;
    // A `pending` row belongs to a starter that has not yet spawned, or to a child
    // that died before it took the lock. Neither is live, and only the second is a
    // failure — the two are indistinguishable from here, so `pending` keeps its
    // own state and only `running` degrades.
    const state = row.state === "running" && holderPid === null ? "failed" : row.state;
    return { kind, row, state, live, holderPid };
}

/** The lifecycle of every transfer kind, in the fixed order. One row read backs all three. */
export function readTransferReports(): readonly TransferReport[] {
    const rows = new Map(
        listTransfers()
            .unwrapOr([])
            .map((row) => [row.id, row]),
    );
    return TRANSFER_KINDS.map((kind) => {
        const holderPid = instanceLockHolder(transferLockKey(kind));
        const row = rows.get(kind) ?? null;
        if (row === null) return { kind, row: null, state: null, live: false, holderPid };
        const started = row.state === "pending" || row.state === "running";
        const live = started && holderPid !== null;
        const state = row.state === "running" && holderPid === null ? "failed" : row.state;
        return { kind, row, state, live, holderPid };
    });
}

/** Whether any transfer child is live right now. The sandbox gate waits on exactly this. */
export function anyTransferLive(): boolean {
    return TRANSFER_KINDS.some((kind) => instanceLockHolder(transferLockKey(kind)) !== null);
}

/**
 * The argv that runs this CLI again. A dev run has no compiled binary, so the
 * source entry is executed by the `bun` runtime; a release binary IS the
 * `inflexa` executable. This module lives at `src/modules/libs/`, thus the CLI
 * source entry is two levels up.
 */
function selfInvocation(argv: readonly string[]): string[] {
    return env.isDevelopment ? [process.execPath, join(import.meta.dir, "../../index.ts"), ...argv] : [process.execPath, ...argv];
}

/**
 * Put a detached child on the machine and report its pid.
 *
 * `.unref()` and the ignored streams are what make it detached: it holds no
 * event loop of the starter, it writes nothing to the terminal of the starter,
 * and it survives that exit. The row is where it reports, and the TUI rows and
 * `inflexa sandbox status` are where a user reads it.
 */
export function spawnDetachedSelf(argv: readonly string[]): number {
    const child = Bun.spawn({ cmd: selfInvocation(argv), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    return child.pid;
}

/** What a start attempt did. Only `started` puts a child on the machine. */
export type TransferStart = { readonly type: "started"; readonly pid: number } | { readonly type: "already_running"; readonly report: TransferReport };

/** A transfer child could not be started. */
export type TransferStartError = { readonly type: "spawn_failed"; readonly kind: TransferKind; readonly message: string; readonly cause?: unknown };

/**
 * The hidden flag that tells a re-invoked `inflexa sandbox pull` to run ONE
 * image transfer in-process rather than start children. The registry
 * (`src/cli/index.ts`) declares the same spelling as a hidden option, because a
 * registry that imported this module would give up its lazy-import discipline
 * for one string.
 */
export const IMAGE_TRANSFER_FLAG = "--run-transfer";

/**
 * Start the detached child of one image transfer kind, or report the child that
 * already runs.
 *
 * `pending` is written BEFORE the spawn, so a reader between the write and the
 * child taking the lock sees a run that is starting rather than the terminal
 * state the last run left. The write is discarded on failure: the row is a
 * readout, and a database this process cannot write must not stop the transfer.
 */
export function startImageTransfer(kind: "runtime_image" | "provisioner_image"): Result<TransferStart, TransferStartError> {
    const report = readTransferReport(kind);
    if (report.live) return ok({ type: "already_running", report });
    startTransferRun(kind, { state: "pending", holderPid: null }).unwrapOr(undefined);
    try {
        return ok({ type: "started", pid: spawnDetachedSelf(["sandbox", "pull", IMAGE_TRANSFER_FLAG, kind]) });
    } catch (cause) {
        const message = "Could not start the image transfer. Run `inflexa sandbox pull` again.";
        settleTransfer(kind, { state: "failed", message }).unwrapOr(undefined);
        return err({ type: "spawn_failed", kind, message, cause });
    }
}

/** The last few non-empty lines of an engine output, for a failure message that names the real cause. */
function outputTail(text: string): string {
    const lines = text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "");
    return lines.slice(-4).join("\n");
}

/** The local digest of an image (`image inspect --format {{.Id}}`), or `null` when the engine does not hold it. */
async function localImageDigest(rt: ContainerRuntime, image: string): Promise<string | null> {
    try {
        const inspected = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]);
        const digest = inspected.stdout.trim();
        return inspected.code === 0 && digest !== "" ? digest : null;
    } catch {
        return null;
    }
}

/**
 * The body of one detached image-transfer child: pull the image, make sure of
 * the digest, and only then remove the superseded image.
 *
 * The order is the safety of the machine. The present image serves every
 * sandbox until the NEW pull verifies — the pull lands under a new digest
 * beside the old one, thus a failed transfer changes nothing and the present
 * image still serves. Only a verified new digest removes the superseded one,
 * and the row's message says that it did, which is the notice the TUI renders.
 *
 * The child takes the lock first, because the lock is what makes the run
 * visible as live to every other process. A start that loses the race writes
 * nothing and returns, thus two children can never both transfer one kind.
 */
export async function runImageTransfer(kind: "runtime_image" | "provisioner_image"): Promise<void> {
    const lock = acquireInstanceLock(transferLockKey(kind));
    if (!lock.acquired) return;
    try {
        startTransferRun(kind, { state: "running", holderPid: process.pid }).unwrapOr(undefined);

        const rtResult = await ensureRuntime();
        if (rtResult.isErr()) {
            settleTransfer(kind, { state: "failed", message: rtResult.error.message }).unwrapOr(undefined);
            return;
        }
        const rt = rtResult.value;
        const sandboxImage = configuredSandboxImage();
        const image = kind === "runtime_image" ? sandboxImage : provisionerImageFor(sandboxImage);

        const previous = await localImageDigest(rt, image);
        let pulled: { code: number; stdout: string; stderr: string };
        try {
            pulled = await capture(rt, ["pull", image]);
        } catch (cause) {
            settleTransfer(kind, {
                state: "failed",
                message: `Could not start \`${rt.bin} pull ${image}\`: ${cause instanceof Error ? cause.message : String(cause)}. Run \`inflexa sandbox pull\` to try again.`,
            }).unwrapOr(undefined);
            return;
        }
        if (pulled.code !== 0) {
            const tail = outputTail(`${pulled.stdout}\n${pulled.stderr}`);
            settleTransfer(kind, {
                state: "failed",
                message: `\`${rt.bin} pull ${image}\` exited ${pulled.code}${tail === "" ? "" : `:\n${tail}`}\nRun \`inflexa sandbox pull\` to try again.`,
            }).unwrapOr(undefined);
            return;
        }

        // The verification: the engine must hold the image it reported pulled. A
        // pull that "succeeded" with no local digest is a fault, and the present
        // image stays in place.
        const digest = await localImageDigest(rt, image);
        if (digest === null) {
            settleTransfer(kind, {
                state: "failed",
                message: `The pull of ${image} reported success and the engine does not hold it. Run \`inflexa sandbox pull\` to try again.`,
            }).unwrapOr(undefined);
            return;
        }
        recordTransferResolve(kind, { digest, totalBytes: null, totalLayers: null }).unwrapOr(0);

        // The superseded image leaves only AFTER the new pull verified. A removal
        // that fails — a container still uses the old image, or another tag holds
        // it — keeps the old bytes, which costs disk and never correctness.
        let notice: string | null = null;
        if (previous !== null && previous !== digest) {
            const removed = await capture(rt, ["rmi", previous]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
            if (removed.code === 0) notice = `The superseded image ${previous.slice(0, 19)} was removed.`;
        }

        // The runtime image carries the baked inventory fragment. Cache it while
        // the image is definitely present; a failure degrades to a fragment-less
        // package list and never fails the transfer.
        if (kind === "runtime_image") await imagePackagesFile(rt, image, env.libsDir);

        settleTransfer(kind, { state: "installed", message: notice }).unwrapOr(undefined);
    } finally {
        releaseInstanceLock(transferLockKey(kind));
    }
}

/** What a stop of a live child did. `no_run` is a normal answer, not a failure. */
export type TransferStop = { readonly type: "stopped"; readonly holderPid: number } | { readonly type: "no_run" };

/** How long the stop waits for the signalled child to go away. */
const STOP_EXIT_WAIT_MS = 3000;

/** How often the stop tests whether the signalled child is gone. */
const STOP_POLL_MS = 50;

/**
 * Signal the live child of one kind and wait for its lock to free.
 *
 * The child is detached, thus a signal is the only thing that reaches it from
 * another terminal. The wait is bounded, and the CALLER settles the row and
 * drops what the kind staged — the catalog cancel owns its staged tree, and an
 * image pull stages nothing the engine does not own.
 */
export async function stopTransferChild(kind: TransferKind): Promise<TransferStop> {
    const report = readTransferReport(kind);
    if (!report.live || report.holderPid === null) return { type: "no_run" };
    const holderPid = report.holderPid;
    try {
        process.kill(holderPid, "SIGTERM");
    } catch {
        // The child went away between the probe and the signal. The wait below settles it.
    }
    for (let waited = 0; waited < STOP_EXIT_WAIT_MS; waited += STOP_POLL_MS) {
        if (instanceLockHolder(transferLockKey(kind)) === null) break;
        await Promise.sleep(STOP_POLL_MS);
    }
    return { type: "stopped", holderPid };
}
