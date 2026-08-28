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
import { z } from "zod";

import { ensureRuntime } from "../../lib/config.ts";
import { capture, resolveEngineSocket, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { acquireInstanceLock, instanceLockHolder, releaseInstanceLock, TRANSFER_LOCK_KEY_PREFIX } from "../../lib/lock.ts";
import { getTransfer, listTransfers } from "../../db/primary_query.ts";
import { recordTransferProgress, recordTransferResolve, settleTransfer, startTransferRun } from "../../db/primary_mutation.ts";
import { TRANSFER_KINDS, type TransferKind, type TransferRow, type TransferStatus } from "../../types/store.ts";
import { provisionerImageFor } from "./images.ts";
import { imagePackagesFile } from "./packages.ts";
import { configuredSandboxImage } from "./pull.ts";

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
 * How often the API pull writes its byte progress, one row write per interval.
 * The sidebar polls at two seconds, thus a finer cadence buys nothing.
 */
const PULL_PROGRESS_WRITE_INTERVAL_MS = 500;

/** The heartbeat cadence of the CLI-pull fallback: the row's `updated_at` moves, thus the row never reads as stuck. */
const PULL_HEARTBEAT_MS = 2000;

/** The docker-API architecture name of this host, for the manifest-index pick. */
function hostArchitecture(): string {
    return process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
}

/** An image reference split for the docker-compat pull API: the repository, and the tag (`latest` when the reference names none). */
function splitImageRef(image: string): { repo: string; tag: string } {
    const slash = image.lastIndexOf("/");
    const name = image.slice(slash + 1);
    const colon = name.indexOf(":");
    if (colon < 0) return { repo: image, tag: "latest" };
    return { repo: image.slice(0, slash + 1) + name.slice(0, colon), tag: name.slice(colon + 1) };
}

/** One registry manifest, leniently: an image manifest carries `layers`, and an index carries `manifests`. */
const manifestSchema = z
    .object({
        layers: z.array(z.object({ size: z.number() }).passthrough()).optional(),
        manifests: z
            .array(z.object({ digest: z.string(), platform: z.object({ architecture: z.string() }).passthrough().optional() }).passthrough())
            .optional(),
    })
    .passthrough();

/**
 * The total bytes of an image, summed over the layer sizes of its registry
 * manifest — resolved BEFORE the pull, thus the meter has its total from the
 * first byte. An index resolves through the entry of this host architecture.
 * `null` when the manifest cannot answer, and the row then renders the moved
 * bytes alone.
 */
async function resolveImageTotalBytes(rt: ContainerRuntime, image: string): Promise<number | null> {
    const probe = async (ref: string): Promise<{ code: number; stdout: string } | null> => {
        try {
            return await capture(rt, ["manifest", "inspect", ref]);
        } catch {
            return null;
        }
    };
    const sumLayers = (raw: string): number | null => {
        const parsed = JSON.parseWith(raw, manifestSchema);
        if (parsed?.layers === undefined || parsed.layers.length === 0) return null;
        return parsed.layers.reduce((n, layer) => n + layer.size, 0);
    };
    const first = await probe(image);
    if (first === null || first.code !== 0) return null;
    const direct = sumLayers(first.stdout);
    if (direct !== null) return direct;
    const parsed = JSON.parseWith(first.stdout, manifestSchema);
    const entry = parsed?.manifests?.find((candidate) => candidate.platform?.architecture === hostArchitecture());
    if (entry === undefined) return null;
    const { repo } = splitImageRef(image);
    const arch = await probe(`${repo}@${entry.digest}`);
    if (arch === null || arch.code !== 0) return null;
    return sumLayers(arch.stdout);
}

/** One progress event of the docker-compat pull stream. An `error` event ends the pull with that reason. */
const pullEventSchema = z
    .object({
        id: z.string().optional(),
        status: z.string().optional(),
        error: z.string().optional(),
        progressDetail: z.object({ current: z.number().optional(), total: z.number().optional() }).optional(),
    })
    .passthrough();

/** How one API pull ended. `unavailable` sends the caller to the CLI fallback, and it is not a failure. */
type ApiPullOutcome = { readonly kind: "completed" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "unavailable" };

/**
 * Pull through the docker-compat API of the engine, and stream the per-layer
 * byte progress into the row. The engine serves `POST /images/create` as a
 * line stream of JSON events, and each `progressDetail.current` is the bytes
 * of one layer so far — the sum is what the meter renders. The CLI `pull`
 * reports no byte figure at all, which is the reason this path exists.
 *
 * An unreachable socket, or a stream that cannot start, reads as
 * `unavailable`: the caller then pulls through the CLI, and only the byte
 * readout is lost.
 */
async function apiPullImage(rt: ContainerRuntime, image: string, kind: "runtime_image" | "provisioner_image"): Promise<ApiPullOutcome> {
    const socket = (await resolveEngineSocket(rt)).unwrapOr(undefined);
    if (socket === undefined) return { kind: "unavailable" };
    const { repo, tag } = splitImageRef(image);
    let response: Response;
    try {
        // `unix` is the Bun fetch extension that dials a unix socket; the host
        // name of the URL is decoration the engine never reads.
        response = await fetch(`http://engine/v1.41/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`, {
            method: "POST",
            unix: socket,
        });
    } catch {
        return { kind: "unavailable" };
    }
    if (!response.ok || response.body === null) return { kind: "unavailable" };

    const layerBytes = new Map<string, number>();
    const layersDone = new Set<string>();
    let failure: string | null = null;
    let lastWrite = 0;
    let buffer = "";
    const decoder = new TextDecoder();
    const consume = (line: string): void => {
        const event = JSON.parseWith(line, pullEventSchema);
        if (event === null) return;
        if (event.error !== undefined) failure = event.error;
        if (event.id === undefined) return;
        const current = event.progressDetail?.current;
        // The stream repeats each layer with a growing `current`; the map keeps
        // the newest figure, and the sum over the map is the moved total.
        if (current !== undefined) layerBytes.set(event.id, Math.max(current, layerBytes.get(event.id) ?? 0));
        if (event.status === "Pull complete" || event.status === "Already exists") layersDone.add(event.id);
    };
    for await (const chunk of response.body) {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk);
        for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line !== "") consume(line);
        }
        const now = Date.now();
        if (now - lastWrite >= PULL_PROGRESS_WRITE_INTERVAL_MS) {
            lastWrite = now;
            // Discarded on failure, and deliberately: the row is a readout, thus a
            // database this child cannot write must never abort a pull.
            recordTransferProgress(kind, {
                bytesTransferred: [...layerBytes.values()].reduce((n, b) => n + b, 0),
                layersCompleted: layersDone.size,
            }).unwrapOr(0);
        }
    }
    if (buffer.trim() !== "") consume(buffer.trim());
    recordTransferProgress(kind, {
        bytesTransferred: [...layerBytes.values()].reduce((n, b) => n + b, 0),
        layersCompleted: layersDone.size,
    }).unwrapOr(0);
    if (failure !== null) return { kind: "failed", message: failure };
    return { kind: "completed" };
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

        // A `localhost/` reference names the engine's own store, never a
        // registry — a pull would ping a registry called "localhost" and
        // refuse on every retry. A dev override is the one source of such a
        // reference, thus the row classifies instead of pulling: a held
        // image is usable as it stands, and an absent one names the remedy.
        if (image.startsWith("localhost/")) {
            const held = await localImageDigest(rt, image);
            if (held !== null) {
                settleTransfer(kind, { state: "installed", message: `${image} is a local image, and the engine holds it. Nothing transfers.` }).unwrapOr(
                    undefined,
                );
            } else {
                settleTransfer(kind, {
                    state: "failed",
                    message: `${image} is a local image, and the engine does not hold it. Build it, or remove the \`harness.sandboxImage\` override so the pull uses the published image.`,
                }).unwrapOr(undefined);
            }
            return;
        }

        const previous = await localImageDigest(rt, image);
        // The total resolves BEFORE the pull, from the registry manifest, thus
        // the meter renders a real ratio from the first byte. A manifest that
        // cannot answer costs only the ratio — the moved bytes still render.
        const totalBytes = await resolveImageTotalBytes(rt, image);
        if (totalBytes !== null) recordTransferResolve(kind, { digest: "", totalBytes, totalLayers: null }).unwrapOr(0);

        const api = await apiPullImage(rt, image, kind);
        if (api.kind === "failed") {
            settleTransfer(kind, {
                state: "failed",
                message: `The pull of ${image} failed: ${api.message}\nRun \`inflexa sandbox pull\` to try again.`,
            }).unwrapOr(undefined);
            return;
        }
        if (api.kind === "unavailable") {
            // The CLI fallback reports no byte figure, thus a heartbeat moves the
            // row's `updated_at` and the row never reads as stuck.
            const heartbeat = setInterval(() => recordTransferProgress(kind, { bytesTransferred: 0, layersCompleted: 0 }).unwrapOr(0), PULL_HEARTBEAT_MS);
            let pulled: { code: number; stdout: string; stderr: string };
            try {
                pulled = await capture(rt, ["pull", image]);
            } catch (cause) {
                settleTransfer(kind, {
                    state: "failed",
                    message: `Could not start \`${rt.bin} pull ${image}\`: ${cause instanceof Error ? cause.message : String(cause)}. Run \`inflexa sandbox pull\` to try again.`,
                }).unwrapOr(undefined);
                return;
            } finally {
                clearInterval(heartbeat);
            }
            if (pulled.code !== 0) {
                const tail = outputTail(`${pulled.stdout}\n${pulled.stderr}`);
                settleTransfer(kind, {
                    state: "failed",
                    message: `\`${rt.bin} pull ${image}\` exited ${pulled.code}${tail === "" ? "" : `:\n${tail}`}\nRun \`inflexa sandbox pull\` to try again.`,
                }).unwrapOr(undefined);
                return;
            }
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
        recordTransferResolve(kind, { digest, totalBytes, totalLayers: null }).unwrapOr(0);

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
