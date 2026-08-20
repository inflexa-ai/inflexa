import { chmodSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { err, ok, Result, ResultAsync } from "neverthrow";

import { downloadToFile, type DownloadError, type DownloadProgress, type FetchLike } from "../../lib/download.ts";
import { RELEASE_REPO } from "./latest.ts";

/**
 * The release asset each platform gets, keyed by `${process.platform}-${process.arch}`. The names are the
 * release's own, and the release says `windows` where node says `win32` — the asymmetry is the reason this
 * table is explicit rather than a template over the two runtime values.
 *
 * A pair that is absent has no published binary, which is a real state: no musl build ships yet.
 */
const RELEASE_ASSETS: Readonly<Record<string, string>> = Object.freeze({
    "darwin-arm64": "inflexa-darwin-arm64",
    "darwin-x64": "inflexa-darwin-x64",
    "linux-x64": "inflexa-linux-x64",
    "linux-arm64": "inflexa-linux-arm64",
    "win32-x64": "inflexa-windows-x64.exe",
});

/** The suffix the old binary is moved to on Windows. See {@link swapBinary} for the reason it exists. */
const RETIRED_SUFFIX = ".old";

/** Why an update could not be installed. Each one names what a person must do next, so the command can say it. */
export type ApplyError =
    | { readonly type: "unsupported_platform"; readonly platform: string }
    | { readonly type: "manifest_failed"; readonly status: number }
    | { readonly type: "manifest_unreachable"; readonly cause: unknown }
    | { readonly type: "asset_missing"; readonly asset: string }
    | { readonly type: "download_failed"; readonly cause: DownloadError }
    | { readonly type: "checksum_mismatch"; readonly expected: string; readonly actual: string }
    | { readonly type: "swap_failed"; readonly path: string; readonly cause: unknown };

/** Options for {@link applyUpdate}. Each one has a production default; a test supplies its own. */
export type ApplyOptions = {
    readonly fetch?: FetchLike;
    readonly onProgress?: (event: DownloadProgress) => void;
    /** The binary to replace. Defaults to the running one, resolved through its symbolic links. */
    readonly targetPath?: string;
    /** The platform/arch key. Defaults to this process's own. */
    readonly platformKey?: string;
};

/** The release asset for `platformKey`, or `null` when no binary is published for it. */
export function releaseAsset(platformKey: string): string | null {
    return RELEASE_ASSETS[platformKey] ?? null;
}

/** The download base for one release tag. */
function releaseBaseUrl(version: string): string {
    return `https://github.com/${RELEASE_REPO}/releases/download/v${version}`;
}

/** Parse a `SHA256SUMS` body into `{asset → digest}`. Each line is `<hex>  <name>`, and a malformed line is skipped. */
function parseSums(body: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const line of body.split("\n")) {
        const [digest, name] = line.trim().split(/\s+/);
        if (digest !== undefined && name !== undefined) sums.set(name, digest);
    }
    return sums;
}

/**
 * Put `staged` at `target`, and give back the path of a file that a later run must sweep.
 *
 * POSIX renames straight over the target. The running process keeps the old inode open, so the swap is
 * invisible to it and the next start gets the new binary.
 *
 * Windows refuses a write or a delete on a running executable, but it permits a RENAME of one. Thus the
 * old binary moves aside first, which frees the name for the new one. The moved file cannot be deleted
 * while this process runs, so its path rides back out for the sweep at the head of the next update. Go and
 * the Rust `self-replace` crate both do exactly this.
 */
function swapBinary(staged: string, target: string): Result<string | null, ApplyError> {
    return Result.fromThrowable(
        (): string | null => {
            if (process.platform !== "win32") {
                renameSync(staged, target);
                return null;
            }
            const retired = `${target}${RETIRED_SUFFIX}`;
            rmSync(retired, { force: true });
            renameSync(target, retired);
            renameSync(staged, target);
            return retired;
        },
        (cause): ApplyError => ({ type: "swap_failed", path: target, cause }),
    )();
}

/**
 * Download release `version` and put it in place of the running binary.
 *
 * ONLY for the `installer` channel — the caller owns that decision (see channel.ts), because
 * replacing a file that Homebrew or npm records would put their bookkeeping out of agreement with the
 * disk. Nothing here re-tests the channel, so nothing here can disagree with the caller about it.
 *
 * The bytes are compared against the release's own `SHA256SUMS` before the swap. https already covers the
 * transport, and the digest covers what the transport cannot: that this is the file the release workflow
 * built and attested. It is the same pair of guarantees `install.sh` gives.
 */
export async function applyUpdate(version: string, options: ApplyOptions = {}): Promise<Result<void, ApplyError>> {
    const doFetch = options.fetch ?? fetch;
    const platformKey = options.platformKey ?? `${process.platform}-${process.arch}`;
    const asset = releaseAsset(platformKey);
    if (asset === null) return err({ type: "unsupported_platform", platform: platformKey });

    // Resolved through its links for the same reason the channel is (see channel.ts): a rename must land
    // on the real file, never on a link that points at it.
    const target =
        options.targetPath ??
        Result.fromThrowable(
            () => realpathSync(process.execPath),
            () => undefined,
        )().unwrapOr(process.execPath);

    // Sweep what a previous Windows update left behind. Best effort by design: the file is only removable
    // once the process that held it has exited, so a failure here means "not yet", never "broken".
    rmSync(`${target}${RETIRED_SUFFIX}`, { force: true });

    const base = releaseBaseUrl(version);
    const manifest = await ResultAsync.fromPromise(
        Promise.resolve().then(() => doFetch(`${base}/SHA256SUMS`)),
        (cause): ApplyError => ({ type: "manifest_unreachable", cause }),
    );
    if (manifest.isErr()) return err(manifest.error);
    if (!manifest.value.ok) return err({ type: "manifest_failed", status: manifest.value.status });

    const body = await ResultAsync.fromPromise(manifest.value.text(), (cause): ApplyError => ({ type: "manifest_unreachable", cause }));
    if (body.isErr()) return err(body.error);

    const expected = parseSums(body.value).get(asset);
    if (expected === undefined) return err({ type: "asset_missing", asset });

    // Staged BESIDE the target so the swap is a rename within one filesystem, which is the only form that
    // is atomic. A staging dir elsewhere would degrade to a copy, and a copy can be interrupted halfway
    // through the file a person is about to run.
    const staged = join(dirname(target), `.inflexa.update.${process.pid}`);
    const downloaded = await downloadToFile(`${base}/${asset}`, staged, { fetch: doFetch, onProgress: options.onProgress });
    if (downloaded.isErr()) return err({ type: "download_failed", cause: downloaded.error });

    if (downloaded.value.sha256 !== expected) {
        rmSync(staged, { force: true });
        return err({ type: "checksum_mismatch", expected, actual: downloaded.value.sha256 });
    }

    // Before the swap, not after: a binary that lands without its executable bit is a broken install, and
    // the staged path is still discardable at this point. Windows carries no such bit and ignores the call.
    const marked = Result.fromThrowable(
        () => chmodSync(staged, 0o755),
        (cause): ApplyError => ({ type: "swap_failed", path: staged, cause }),
    )();
    if (marked.isErr()) {
        rmSync(staged, { force: true });
        return err(marked.error);
    }

    return swapBinary(staged, target).match(
        () => ok<void, ApplyError>(undefined),
        (error) => {
            rmSync(staged, { force: true });
            return err<void, ApplyError>(error);
        },
    );
}

/** A one-line reason for `error`, for a person reading a terminal or a dialog. */
export function applyErrorMessage(error: ApplyError): string {
    switch (error.type) {
        case "unsupported_platform":
            return `No release binary is published for ${error.platform}.`;
        case "manifest_failed":
            return `The release checksum file answered with status ${error.status}.`;
        case "manifest_unreachable":
            return `Could not reach the release checksum file: ${String(error.cause)}`;
        case "asset_missing":
            return `The release does not list ${error.asset}.`;
        case "download_failed":
            return `The download failed: ${error.cause.message}`;
        case "checksum_mismatch":
            return `The downloaded binary does not match the released checksum (expected ${error.expected}, got ${error.actual}).`;
        case "swap_failed":
            return `Could not write ${error.path}. Run the installer again, or use a shell that can write that directory.`;
        default: {
            const unreachable: never = error;
            throw new Error(`unhandled apply error: ${JSON.stringify(unreachable)}`);
        }
    }
}
