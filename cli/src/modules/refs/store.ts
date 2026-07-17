import { createHash } from "node:crypto";
import { createWriteStream, type Stats } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { randomUUIDv7 } from "bun";

import {
    REFERENCE_DATA_CATALOG,
    REFERENCE_INSTALL_RECEIPT_VERSION,
    parseReferenceInstallReceipt,
    referenceArtifactKey,
    resolveReferenceInstallPlan,
    type ReferenceArtifact,
    type ReferenceDataCatalog,
    type ReferenceDataset,
    type ReferenceInstallPlan,
    type ReferenceInstallPlanDataset,
    type ReferenceInstallReceipt,
    type ReferenceReceiptArtifact,
    type UnknownReferenceDatasetError,
} from "@inflexa-ai/harness";
import { err, ok, type Result } from "neverthrow";

import { sha256File } from "../../lib/hash.ts";

/** Reserved and user-owned paths below one public reference store. */
export type ReferenceStorePaths = {
    /** Public store mounted into sandboxes. */
    readonly root: string;
    /** Catalog-managed immutable datasets. */
    readonly managed: string;
    /** User-owned arbitrary reference data. */
    readonly user: string;
    /** Installer-owned metadata and temporary state. */
    readonly metadata: string;
    /** Active installation receipts. */
    readonly receipts: string;
    /** Per-attempt complete-dataset staging. */
    readonly staging: string;
    /** Resumable artifact partials. */
    readonly downloads: string;
};

/** Cheap local state shown by `refs list`. */
export type ReferenceDatasetState = "missing" | "installed" | "update_available" | "partial" | "invalid_receipt";

/** Catalog dataset paired with its cheap local state. */
export type ReferenceDatasetInspection = {
    /** Canonical catalog entry. */
    readonly dataset: ReferenceDataset;
    /** Recoverable local state. */
    readonly state: ReferenceDatasetState;
    /** Valid active receipt, when present. */
    readonly receipt?: ReferenceInstallReceipt;
};

/** Passive store inspection, including content the installer does not own. */
export type ReferenceStoreInspection = {
    /** Whether the public root exists. */
    readonly exists: boolean;
    /** State for every canonical catalog dataset. */
    readonly datasets: readonly ReferenceDatasetInspection[];
    /** Unknown top-level entries, including user content, never adopted by the installer. */
    readonly userContent: readonly string[];
};

/** One file-level verification result. */
export type ReferenceFileVerification = {
    /** Dataset-relative final path. */
    readonly path: string;
    /** Verification outcome, checked against the size and digest recorded in the receipt at install. */
    readonly state: "valid" | "missing" | "modified";
};

/** Explicit verification result for an active catalog dataset. */
export type ReferenceVerification = {
    /** Stable dataset id. */
    readonly datasetId: string;
    /** Active receipt version, when valid. */
    readonly version?: string;
    /** File results; empty when no valid receipt exists. */
    readonly files: readonly ReferenceFileVerification[];
    /** Overall state. */
    readonly state: "valid" | "missing" | "invalid_receipt" | "modified";
};

type UnknownDatasetError = {
    /** Stable discriminator. */
    readonly type: "unknown_dataset";
    /** User-facing explanation. */
    readonly message: string;
    /** Requested unknown id. */
    readonly unknownId: string;
    /** Catalog ids available to select. */
    readonly availableIds: readonly string[];
};

type ProvisionOperationError = {
    /** Failure stage. */
    readonly type: "io_failed" | "download_failed";
    /** User-facing explanation. */
    readonly message: string;
    /** Underlying filesystem/network failure, when present. */
    readonly cause?: unknown;
};

type ManagedPathConflictError = {
    /** Stable discriminator. */
    readonly type: "managed_path_conflict";
    /** User-facing explanation. */
    readonly message: string;
    /** Conflicting or unsafe path. */
    readonly path: string;
};

/** Typed failures from local inspection, verification, transfer, or activation. */
export type ReferenceProvisionError = UnknownDatasetError | ProvisionOperationError | ManagedPathConflictError;

/** Network dependencies supplied by the CLI composition edge. */
export type ReferenceInstallDeps = {
    /** Public store root. */
    readonly root: string;
    /** Catalog/plan seam used by tests; production always defaults to the immutable harness source. */
    readonly source?: ReferenceCatalogSource;
    /** Fetch implementation; defaults to the runtime fetch. */
    readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    /** Clock used in receipts. */
    readonly now?: () => Date;
    /** Stable attempt id used for staging. */
    readonly attemptId?: () => string;
};

/** Caller-chosen installation behavior. */
export type ReferenceInstallOptions = {
    /**
     * Re-fetch and re-activate even when the active install is intact. Because the catalog pins no
     * digest, this is the only way to pull a fresh copy of a dataset whose upstream has moved on —
     * an intact install of the bytes we previously received is indistinguishable from an up-to-date
     * one without going to the network.
     */
    readonly force?: boolean;
};

/** Read-only catalog plus the matching pure selection operation. */
export type ReferenceCatalogSource = {
    /** Catalog metadata used for listing and state comparison. */
    readonly catalog: ReferenceDataCatalog;
    /** Resolve ids against exactly that catalog. */
    readonly resolveInstallPlan: (datasetIds: readonly string[]) => Result<ReferenceInstallPlan, UnknownReferenceDatasetError>;
};

const CANONICAL_REFERENCE_SOURCE: ReferenceCatalogSource = {
    catalog: REFERENCE_DATA_CATALOG,
    resolveInstallPlan: resolveReferenceInstallPlan,
};

/** One activated dataset. */
export type InstalledReferenceDataset = {
    /** Stable catalog id. */
    readonly id: string;
    /** Activated catalog version. */
    readonly version: string;
    /** Network bytes transferred in this operation. */
    readonly bytesDownloaded: number;
};

/** Successful installation details. */
export type ReferenceInstallOutcome = {
    /** Activated datasets in deterministic id order. */
    readonly installed: readonly InstalledReferenceDataset[];
};

/** What a download would fetch. The catalog carries no sizes, so only a count is knowable locally. */
export type ReferenceDownloadEstimate = {
    /** Artifacts that still need fetching, whose sizes only the upstream can report. */
    readonly artifactsToFetch: number;
};

/** Resolve all owned paths without creating anything. */
export function referenceStorePaths(root: string): ReferenceStorePaths {
    const metadata = join(root, ".inflexa");
    return {
        root,
        managed: join(root, "managed"),
        user: join(root, "user"),
        metadata,
        receipts: join(metadata, "receipts"),
        staging: join(metadata, "staging"),
        downloads: join(metadata, "downloads"),
    };
}

/** Deliberately create the public store and recommended user namespace. */
export async function ensureReferenceStore(root: string): Promise<Result<ReferenceStorePaths, ReferenceProvisionError>> {
    const paths = referenceStorePaths(root);
    try {
        const owned = await assertOwnedPath(root, paths.user);
        if (owned.isErr()) return err(owned.error);
        await mkdir(paths.user, { recursive: true });
        return ok(paths);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not create reference store at ${root}.`, cause });
    }
}

async function pathStat(path: string): Promise<Result<Stats | undefined, ReferenceProvisionError>> {
    try {
        return ok(await stat(path));
    } catch (cause) {
        return isMissing(cause) ? ok(undefined) : err({ type: "io_failed", message: `Could not stat ${path}.`, cause });
    }
}

async function pathLstat(path: string): Promise<Result<Stats | undefined, ReferenceProvisionError>> {
    try {
        return ok(await lstat(path));
    } catch (cause) {
        return isMissing(cause) ? ok(undefined) : err({ type: "io_failed", message: `Could not inspect ${path}.`, cause });
    }
}

function isMissing(cause: unknown): boolean {
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

async function readReceipt(path: string, storeRoot: string): Promise<{ readonly exists: boolean; readonly receipt?: ReferenceInstallReceipt }> {
    try {
        const owned = await assertOwnedPath(storeRoot, path);
        if (owned.isErr()) return { exists: true };
        const infoResult = await pathLstat(path);
        if (infoResult.isErr()) return { exists: true };
        const info = infoResult.value;
        if (info === undefined) return { exists: false };
        if (info.isSymbolicLink() || !info.isFile()) return { exists: true };
        const raw: unknown = JSON.parse(await readFile(path, "utf8"));
        return { exists: true, receipt: parseReferenceInstallReceipt(raw) };
    } catch (cause) {
        if (isMissing(cause)) return { exists: false };
        return { exists: true };
    }
}

async function receiptFilesPresent(paths: ReferenceStorePaths, root: string, receipt: ReferenceInstallReceipt): Promise<boolean> {
    for (const artifact of receipt.artifacts) {
        const path = join(root, artifact.path);
        // Contained against the dataset's own root, not the store's: `managed/` and `user/` are
        // siblings, so a store-scoped check would let a receipt path reach into user content or a
        // neighbouring dataset. The receipt schema already refuses traversal segments — this is the
        // second lock on the same door, because the receipt is a file on disk that anyone can edit.
        const owned = await assertOwnedPath(root, path);
        if (owned.isErr()) return false;
        const fileResult = await pathLstat(path);
        // Cheap state deliberately treats unreadable content as damaged/partial: it must never claim
        // an installation is usable when the sandbox cannot read it. Explicit verify retains the
        // file-level invalid outcome while top-level I/O failures still use the Result channel.
        if (fileResult.isErr()) return false;
        const file = fileResult.value;
        if (file === undefined || file.isSymbolicLink() || !file.isFile() || file.size !== artifact.bytes) return false;
    }
    return true;
}

/**
 * Whether every activated file still hashes to what the receipt recorded. This is the
 * authoritative completeness check — `receiptFilesPresent` compares sizes only, so a
 * same-size corruption (bit rot, a hand-edit) reads as "installed" to it. Install and
 * download-planning both gate on *this*, so a damaged dataset re-downloads and heals
 * instead of being silently skipped.
 */
async function receiptFilesIntact(paths: ReferenceStorePaths, root: string, receipt: ReferenceInstallReceipt): Promise<boolean> {
    for (const artifact of receipt.artifacts) {
        const path = join(root, artifact.path);
        const owned = await assertOwnedPath(root, path);
        if (owned.isErr()) return false;
        const fileResult = await pathLstat(path);
        if (fileResult.isErr()) return false;
        const file = fileResult.value;
        if (file === undefined || file.isSymbolicLink() || !file.isFile() || file.size !== artifact.bytes) return false;
        const digest = await sha256File(path);
        if (digest.isErr() || digest.value !== artifact.sha256) return false;
    }
    return true;
}

/**
 * Whether the receipt still describes the same dataset the catalog now names: same version and the
 * same set of artifact destinations. The catalog carries no size or digest to compare against —
 * those live only in the receipt (observed at install) and are checked against the files themselves
 * by `verify`, not against the catalog.
 */
function receiptMatchesCurrentCatalog(dataset: ReferenceDataset, receipt: ReferenceInstallReceipt): boolean {
    if (receipt.datasetVersion !== dataset.version || receipt.artifacts.length !== dataset.artifacts.length) return false;
    const expected = new Set(dataset.artifacts.map((artifact) => artifact.path));
    const actualPaths = new Set(receipt.artifacts.map((artifact) => artifact.path));
    if (actualPaths.size !== receipt.artifacts.length) return false;
    return receipt.artifacts.every((recorded) => expected.has(recorded.path));
}

function activeManagedRoot(paths: ReferenceStorePaths, dataset: ReferenceDataset, receipt: ReferenceInstallReceipt): string | undefined {
    if (receipt.datasetId !== dataset.id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(receipt.datasetVersion)) return undefined;
    const root = join(paths.managed, dataset.id, receipt.datasetVersion);
    return containedPath(paths.managed, root) ? root : undefined;
}

/** Inspect catalog state without creating or modifying the store. */
export async function inspectReferenceStore(
    root: string,
    catalog: ReferenceDataCatalog = REFERENCE_DATA_CATALOG,
): Promise<Result<ReferenceStoreInspection, ReferenceProvisionError>> {
    const paths = referenceStorePaths(root);
    try {
        const rootInfoResult = await pathLstat(root);
        if (rootInfoResult.isErr()) return err(rootInfoResult.error);
        const rootInfo = rootInfoResult.value;
        if (rootInfo === undefined) {
            return ok({
                exists: false,
                datasets: catalog.datasets.map((dataset) => ({ dataset, state: "missing" })),
                userContent: [],
            });
        }
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
            return err({ type: "io_failed", message: `Reference store is not a real directory: ${root}` });
        }
        const top = await readdir(root);
        let userEntries: string[] = [];
        try {
            userEntries = await readdir(paths.user);
        } catch (cause) {
            if (!isMissing(cause)) return err({ type: "io_failed", message: `Could not inspect user references at ${paths.user}.`, cause });
        }
        const userContent = [
            ...top.filter((name) => name !== "managed" && name !== ".inflexa" && name !== "user"),
            ...userEntries.map((name) => `user/${name}`),
        ].sort();
        const datasets: ReferenceDatasetInspection[] = [];
        for (const dataset of catalog.datasets) {
            const receiptRead = await readReceipt(join(paths.receipts, `${dataset.id}.json`), paths.root);
            if (receiptRead.exists && receiptRead.receipt === undefined) {
                datasets.push({ dataset, state: "invalid_receipt" });
                continue;
            }
            const receipt = receiptRead.receipt;
            if (receipt === undefined) {
                const versionResult = await pathStat(join(paths.managed, dataset.id, dataset.version));
                if (versionResult.isErr()) return err(versionResult.error);
                const version = versionResult.value;
                datasets.push({ dataset, state: version === undefined ? "missing" : "partial" });
                continue;
            }
            const activeRoot = activeManagedRoot(paths, dataset, receipt);
            if (receipt.datasetVersion === dataset.version && !receiptMatchesCurrentCatalog(dataset, receipt)) {
                datasets.push({ dataset, state: "invalid_receipt" });
                continue;
            }
            const complete = activeRoot !== undefined && (await receiptFilesPresent(paths, activeRoot, receipt));
            if (!complete) datasets.push({ dataset, receipt, state: "partial" });
            else if (receipt.datasetVersion !== dataset.version) datasets.push({ dataset, receipt, state: "update_available" });
            else datasets.push({ dataset, receipt, state: "installed" });
        }
        return ok({ exists: true, datasets, userContent });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect reference store at ${root}.`, cause });
    }
}

/**
 * Hash active managed files against the receipt without mutating disk. The receipt is the sole
 * reference: the catalog pins no digest, so this compares each file to the size and digest observed
 * when it was installed — the honest record of what the upstream actually served at that time.
 */
export async function verifyReferenceDatasets(
    root: string,
    datasetIds: readonly string[],
    source: ReferenceCatalogSource = CANONICAL_REFERENCE_SOURCE,
): Promise<Result<readonly ReferenceVerification[], ReferenceProvisionError>> {
    const plan = source.resolveInstallPlan(datasetIds);
    if (plan.isErr()) {
        return err({
            type: "unknown_dataset",
            message: plan.error.message,
            unknownId: plan.error.unknownId,
            availableIds: plan.error.availableIds,
        });
    }
    const paths = referenceStorePaths(root);
    try {
        const results: ReferenceVerification[] = [];
        for (const dataset of plan.value.datasets) {
            const receiptRead = await readReceipt(join(paths.receipts, `${dataset.id}.json`), paths.root);
            if (!receiptRead.exists) {
                results.push({ datasetId: dataset.id, files: [], state: "missing" });
                continue;
            }
            const receipt = receiptRead.receipt;
            const activeRoot = receipt === undefined ? undefined : activeManagedRoot(paths, dataset, receipt);
            if (
                receipt === undefined ||
                activeRoot === undefined ||
                (receipt.datasetVersion === dataset.version && !receiptMatchesCurrentCatalog(dataset, receipt))
            ) {
                results.push({ datasetId: dataset.id, files: [], state: "invalid_receipt" });
                continue;
            }
            const files: ReferenceFileVerification[] = [];
            for (const artifact of receipt.artifacts) {
                const path = join(activeRoot, artifact.path);
                const owned = await assertOwnedPath(activeRoot, path);
                const infoResult = owned.isOk() ? await pathLstat(path) : ok(undefined);
                const info = infoResult.isOk() ? infoResult.value : undefined;
                if (info === undefined || info.isSymbolicLink() || !info.isFile()) {
                    files.push({ path: artifact.path, state: "missing" });
                    continue;
                }
                if (info.size !== artifact.bytes) {
                    files.push({ path: artifact.path, state: "modified" });
                    continue;
                }
                const digestResult = await sha256File(path);
                files.push({
                    path: artifact.path,
                    state: digestResult.isOk() && digestResult.value === artifact.sha256 ? "valid" : "modified",
                });
            }
            const state = files.every((file) => file.state === "valid") ? "valid" : files.some((file) => file.state === "modified") ? "modified" : "missing";
            results.push({ datasetId: dataset.id, version: receipt.datasetVersion, files, state });
        }
        return ok(results);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not verify reference store at ${root}.`, cause });
    }
}

function downloadName(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}

async function assertOwnedPath(root: string, candidate: string): Promise<Result<void, ReferenceProvisionError>> {
    try {
        if (!containedPath(root, candidate)) {
            return err({ type: "managed_path_conflict", path: candidate, message: `Installer-owned path escapes the reference store: ${candidate}` });
        }
        const rootInfoResult = await pathLstat(root);
        if (rootInfoResult.isErr()) return err(rootInfoResult.error);
        const rootInfo = rootInfoResult.value;
        if (rootInfo !== undefined && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) {
            return err({ type: "managed_path_conflict", path: root, message: `Reference store root is not a real directory: ${root}` });
        }
        const rel = relative(root, candidate);
        let current = root;
        for (const segment of rel.split(sep).filter(Boolean)) {
            current = join(current, segment);
            const infoResult = await pathLstat(current);
            if (infoResult.isErr()) return err(infoResult.error);
            const info = infoResult.value;
            if (info === undefined) break;
            if (info.isSymbolicLink()) {
                return err({ type: "managed_path_conflict", path: current, message: `Refusing installer-owned symlink path: ${current}` });
            }
            if (current !== candidate && !info.isDirectory()) {
                return err({ type: "managed_path_conflict", path: current, message: `Installer-owned path ancestor is not a directory: ${current}` });
            }
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect installer-owned path ${candidate}.`, cause });
    }
}

/** What one transfer actually produced, whether or not the catalog could predict it. */
type DownloadedArtifact = {
    readonly partPath: string;
    readonly bytesDownloaded: number;
    readonly observed: ReferenceReceiptArtifact;
};

async function downloadArtifact(
    dataset: ReferenceInstallPlanDataset,
    artifact: ReferenceArtifact,
    paths: ReferenceStorePaths,
    deps: ReferenceInstallDeps,
): Promise<Result<DownloadedArtifact, ReferenceProvisionError>> {
    const key = referenceArtifactKey(dataset, artifact);
    const partPath = join(paths.downloads, `${downloadName(key)}.part`);
    try {
        const owned = await assertOwnedPath(paths.root, partPath);
        if (owned.isErr()) return err(owned.error);
        await mkdir(paths.downloads, { recursive: true });

        // The catalog carries no size or digest, so a partial file cannot be told apart from a
        // complete one, and appending to bytes the upstream may have changed would splice two
        // versions together — always fetch the whole artifact fresh.
        // TODO(robustness): a conditional If-Range resume could restore resumable large downloads
        // without that risk, keying the precondition off an ETag captured on the first attempt.
        await rm(partPath, { force: true });

        const response = await (deps.fetch ?? fetch)(artifact.url, {});
        if (!response.ok || response.body === null) {
            return err({
                type: "download_failed",
                message: `Download failed for ${artifact.path}: HTTP ${response.status} ${response.statusText} (${artifact.url})`,
            });
        }
        // https is now the whole integrity story: nothing downstream re-checks the bytes against a
        // reviewed digest, so a downgraded redirect hop would be trusted on first use. The catalog
        // guarantees an https URL, but fetch follows redirects, so enforce it on whatever served us.
        if (response.url !== "" && !response.url.startsWith("https://")) {
            return err({
                type: "download_failed",
                message: `Refusing ${artifact.path}: ${artifact.url} redirected to a non-https location (${response.url}).`,
            });
        }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partPath, { flags: "w" }));
        const written = (await stat(partPath)).size;
        const digest = await sha256File(partPath);
        if (digest.isErr()) return err({ type: "io_failed", message: `Could not hash ${artifact.path}.`, cause: digest.error.cause });
        return ok({
            partPath,
            bytesDownloaded: written,
            observed: { path: artifact.path, bytes: written, sha256: digest.value },
        });
    } catch (cause) {
        return err({ type: "download_failed", message: `Download failed for ${artifact.path} (${artifact.url}).`, cause });
    }
}

function containedPath(root: string, child: string): boolean {
    const rel = relative(resolve(root), resolve(child));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function assertReplaceable(finalRoot: string, dataset: ReferenceInstallPlanDataset): Promise<Result<void, ReferenceProvisionError>> {
    const existingResult = await pathLstat(finalRoot);
    if (existingResult.isErr()) return err(existingResult.error);
    const existing = existingResult.value;
    if (existing === undefined) return ok(undefined);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
        return err({ type: "managed_path_conflict", path: finalRoot, message: `Refusing to replace non-directory managed path: ${finalRoot}` });
    }
    const allowed = new Set(dataset.artifacts.map((artifact) => artifact.path));
    const allowedDirectories = new Set(
        dataset.artifacts.flatMap((artifact) => {
            const segments = artifact.path.split("/").slice(0, -1);
            return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
        }),
    );
    const visit = async (dir: string): Promise<Result<void, ReferenceProvisionError>> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            const rel = relative(finalRoot, full).split(sep).join("/");
            const link = await lstat(full);
            if (link.isSymbolicLink())
                return err({ type: "managed_path_conflict", path: full, message: `Refusing to replace symlink in managed dataset: ${full}` });
            if (entry.isDirectory()) {
                if (!allowedDirectories.has(rel)) {
                    return err({ type: "managed_path_conflict", path: full, message: `Refusing to overwrite unexpected managed directory: ${full}` });
                }
                const nested = await visit(full);
                if (nested.isErr()) return nested;
            } else if (!entry.isFile() || !allowed.has(rel)) {
                return err({ type: "managed_path_conflict", path: full, message: `Refusing to overwrite unexpected managed content: ${full}` });
            }
        }
        return ok(undefined);
    };
    try {
        return await visit(finalRoot);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect existing managed path ${finalRoot}.`, cause });
    }
}

async function writeReceiptAtomic(path: string, receipt: ReferenceInstallReceipt): Promise<Result<void, ReferenceProvisionError>> {
    const temp = `${path}.${randomUUIDv7()}.tmp`;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
        await rename(temp, path);
        return ok(undefined);
    } catch (cause) {
        await rm(temp, { force: true }).catch(() => undefined);
        return err({ type: "io_failed", message: `Could not atomically write reference receipt ${path}.`, cause });
    }
}

async function installDataset(
    dataset: ReferenceInstallPlanDataset,
    paths: ReferenceStorePaths,
    deps: ReferenceInstallDeps,
    options: ReferenceInstallOptions,
): Promise<Result<InstalledReferenceDataset, ReferenceProvisionError>> {
    const attempt = deps.attemptId?.() ?? `${Date.now()}-${createHash("sha256").update(dataset.id).digest("hex").slice(0, 8)}`;
    const attemptRoot = join(paths.staging, attempt);
    const stageRoot = join(attemptRoot, dataset.installPath);
    const finalRoot = join(paths.managed, dataset.installPath);
    if (!containedPath(paths.staging, stageRoot) || !containedPath(paths.managed, finalRoot)) {
        return err({ type: "managed_path_conflict", path: finalRoot, message: `Unsafe managed destination for ${dataset.id}.` });
    }
    const stageOwned = await assertOwnedPath(paths.root, stageRoot);
    if (stageOwned.isErr()) return err(stageOwned.error);
    const finalOwned = await assertOwnedPath(paths.root, finalRoot);
    if (finalOwned.isErr()) return err(finalOwned.error);
    const replaceable = await assertReplaceable(finalRoot, dataset);
    if (replaceable.isErr()) return err(replaceable.error);
    const receiptRead = await readReceipt(join(paths.receipts, `${dataset.id}.json`), paths.root);
    const activeReceipt = receiptRead.receipt;
    if (!options.force && activeReceipt !== undefined) {
        const activeRoot = activeManagedRoot(paths, dataset, activeReceipt);
        if (activeRoot !== undefined && receiptMatchesCurrentCatalog(dataset, activeReceipt) && (await receiptFilesIntact(paths, activeRoot, activeReceipt))) {
            return ok({ id: dataset.id, version: dataset.version, bytesDownloaded: 0 });
        }
    }
    let bytesDownloaded = 0;
    try {
        await rm(attemptRoot, { recursive: true, force: true });
        await mkdir(stageRoot, { recursive: true });
        const observed: ReferenceReceiptArtifact[] = [];
        for (const artifact of dataset.artifacts) {
            const downloaded = await downloadArtifact(dataset, artifact, paths, deps);
            if (downloaded.isErr()) return err(downloaded.error);
            bytesDownloaded += downloaded.value.bytesDownloaded;
            observed.push(downloaded.value.observed);
            const destination = join(stageRoot, artifact.path);
            if (!containedPath(stageRoot, destination)) {
                return err({ type: "managed_path_conflict", path: destination, message: `Unsafe artifact destination ${artifact.path}.` });
            }
            await mkdir(dirname(destination), { recursive: true });
            await copyFile(downloaded.value.partPath, destination);
        }

        await mkdir(dirname(finalRoot), { recursive: true });
        const receiptPath = join(paths.receipts, `${dataset.id}.json`);
        const receiptOwned = await assertOwnedPath(paths.root, receiptPath);
        if (receiptOwned.isErr()) return err(receiptOwned.error);
        const backup = `${finalRoot}.previous-${attempt}`;
        const finalStatus = await pathStat(finalRoot);
        if (finalStatus.isErr()) return err(finalStatus.error);
        const hadFinal = finalStatus.value !== undefined;
        if (hadFinal) await rename(finalRoot, backup);
        try {
            await rename(stageRoot, finalRoot);
        } catch (cause) {
            await rm(finalRoot, { recursive: true, force: true }).catch(() => undefined);
            if (hadFinal) await rename(backup, finalRoot).catch(() => undefined);
            return err({ type: "io_failed", message: `Could not activate ${dataset.id}@${dataset.version}; prior activation was preserved.`, cause });
        }
        const receipt: ReferenceInstallReceipt = {
            version: REFERENCE_INSTALL_RECEIPT_VERSION,
            datasetId: dataset.id,
            datasetVersion: dataset.version,
            activatedAt: (deps.now?.() ?? new Date()).toISOString(),
            artifacts: observed,
        };
        const receiptWrite = await writeReceiptAtomic(receiptPath, receipt);
        if (receiptWrite.isErr()) {
            await rm(finalRoot, { recursive: true, force: true }).catch(() => undefined);
            if (hadFinal) await rename(backup, finalRoot).catch(() => undefined);
            return err(receiptWrite.error);
        }
        if (hadFinal) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
        for (const artifact of dataset.artifacts) {
            await rm(join(paths.downloads, `${downloadName(referenceArtifactKey(dataset, artifact))}.part`), { force: true }).catch(() => undefined);
        }
        return ok({ id: dataset.id, version: dataset.version, bytesDownloaded });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not stage ${dataset.id}@${dataset.version}.`, cause });
    } finally {
        // The activation `rename` moves the staged version dir out, leaving its parents
        // behind; every attempt gets a fresh id, so without this they accumulate forever.
        await rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Resolve, download, verify, and atomically activate selected catalog datasets. */
export async function installReferenceDatasets(
    datasetIds: readonly string[],
    deps: ReferenceInstallDeps,
    options: ReferenceInstallOptions = {},
): Promise<Result<ReferenceInstallOutcome, ReferenceProvisionError>> {
    const plan = (deps.source ?? CANONICAL_REFERENCE_SOURCE).resolveInstallPlan(datasetIds);
    if (plan.isErr()) {
        return err({
            type: "unknown_dataset",
            message: plan.error.message,
            unknownId: plan.error.unknownId,
            availableIds: plan.error.availableIds,
        });
    }
    const ensured = await ensureReferenceStore(deps.root);
    if (ensured.isErr()) return err(ensured.error);
    const installed: InstalledReferenceDataset[] = [];
    for (const dataset of plan.value.datasets) {
        const result = await installDataset(dataset, ensured.value, deps, options);
        if (result.isErr()) return err(result.error);
        installed.push(result.value);
    }
    return ok({ installed });
}

/** Estimate the transfer without creating state or contacting any upstream. */
export async function referenceDownloadEstimate(
    datasetIds: readonly string[],
    root: string,
    source: ReferenceCatalogSource = CANONICAL_REFERENCE_SOURCE,
    options: ReferenceInstallOptions = {},
): Promise<Result<ReferenceDownloadEstimate, ReferenceProvisionError>> {
    const plan = source.resolveInstallPlan(datasetIds);
    if (plan.isErr()) {
        return err({ type: "unknown_dataset", message: plan.error.message, unknownId: plan.error.unknownId, availableIds: plan.error.availableIds });
    }
    const paths = referenceStorePaths(root);
    try {
        let artifactsToFetch = 0;
        for (const dataset of plan.value.datasets) {
            const receiptRead = await readReceipt(join(paths.receipts, `${dataset.id}.json`), paths.root);
            const activeReceipt = receiptRead.receipt;
            if (!options.force && activeReceipt !== undefined) {
                const activeRoot = activeManagedRoot(paths, dataset, activeReceipt);
                if (
                    activeRoot !== undefined &&
                    receiptMatchesCurrentCatalog(dataset, activeReceipt) &&
                    (await receiptFilesIntact(paths, activeRoot, activeReceipt))
                ) {
                    continue;
                }
            }
            // The catalog knows no sizes, and there is no resume to net out, so the estimate is a
            // count: every artifact of a dataset that is not already intact is fetched fresh.
            artifactsToFetch += dataset.artifacts.length;
        }
        return ok({ artifactsToFetch });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect the reference store at ${root}.`, cause });
    }
}
