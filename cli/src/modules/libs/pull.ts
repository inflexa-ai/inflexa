/**
 * The `inflexa libs` command actions — pull, status — plus the pre-launch
 * lazy offer. `libsPull` is the ONE dogfooded provisioning path: the `libs pull`
 * command, the `inflexa setup` wizard, and the build change's Gate 2 validator
 * (`--pin <candidate>`) all funnel through it. There is no second download
 * code path (design.md "Three entry points, one handler").
 *
 * The algorithm (design.md "The pull algorithm"):
 *   arch → manifest → plan(skip held digests) → confirm →
 *   parallel download+verify → extract → assemble packages.txt → sanity →
 *   atomic activate → prune.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log, spinner as clackSpinner } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { readConfig } from "../../lib/config.ts";
import { confirm } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/lock.ts";
import { ARM64_NO_R_REASON, detectArch, TRACK_SUBTREE, type Track } from "./arch.ts";
import { fetchManifest, manifestUrl, resolveBaseUrl, type Manifest, type TrackEntry } from "./manifest.ts";
import { activate, blobPath, cacheDir, discardStaging, ensureStoreDirs, hasBlob, newStagingDir, prune, readActive, writeMeta } from "./store.ts";

/** How many past versions to retain after a successful pull (current + one rollback). */
const KEEP_VERSIONS = 2;

/**
 * Upper bound on best-effort manifest probes (the pre-launch offer on the boot hot
 * path, the `libs status` up-to-date check): a blackholed store host must never
 * stall boot or hang status — on timeout the probe's result is simply omitted.
 */
const MANIFEST_PROBE_TIMEOUT_MS = 3000;

/** Machine-wide instance-lock key (`lib/lock.ts`) serializing all store mutation: one pull at a time. */
const LIB_STORE_LOCK_KEY = "lib-store";

/**
 * The advisory header prepended to the assembled `packages.txt`. Byte-for-byte
 * identical to the local/offline assembler's `lib_store_packages_header`
 * (`scripts/lib-store-common.sh`): both the `libs pull` handler and the shell
 * builder must emit the SAME runtime file for the same fragments, so this note
 * (agent-facing at mount time — "there is no network, do not install") is
 * carried by every store however it was produced. The two comment lines plus the
 * trailing blank mirror the shell's `header; echo`.
 */
const PACKAGES_TXT_HEADER =
    "# Available packages in the sandbox environment.\n" + "# Do NOT attempt to install packages — there is no network access and no build toolchain.\n" + "\n";

/**
 * Canonical section order for the assembled `packages.txt`: R triple first, then
 * python/conda/node. Mirrors `LIB_STORE_CONCAT_ORDER` in `scripts/lib-store-common.sh`
 * so the `libs pull` handler and the local/offline shell assembler emit the SAME
 * file for the same fragments (independent of pull/extract order). Every {@link Track}
 * appears here; a track not listed (future addition) sorts last rather than being dropped.
 */
const PACKAGES_TXT_CONCAT_ORDER: readonly Track[] = ["cran", "bioconductor", "github", "python", "conda", "node"];

/**
 * A track's root-level `packages.txt` fragment filename, as packed by the
 * producer. Mirrors `lib_store_track_fragment` in `scripts/lib-store-common.sh`
 * (`<track>.packages.txt`, at the store root — NOT `<subtree>/packages.txt`).
 */
function trackFragmentFile(track: Track): string {
    return `${track}.packages.txt`;
}

/** Whether a manifest track name is one this CLI knows where to place. */
function isKnownTrack(track: string): track is Track {
    // Object.hasOwn, NOT `in`: `in` walks the prototype chain, so a manifest naming
    // a track "toString" would pass and TRACK_SUBTREE["toString"] is a function.
    return Object.hasOwn(TRACK_SUBTREE, track);
}

/** Sort track names into {@link PACKAGES_TXT_CONCAT_ORDER}; names not listed sort last, never dropped. */
function canonicalTrackOrder(tracks: readonly string[]): string[] {
    const rank = (t: string): number => {
        const i = PACKAGES_TXT_CONCAT_ORDER.indexOf(t as Track);
        return i === -1 ? PACKAGES_TXT_CONCAT_ORDER.length : i;
    };
    return [...tracks].sort((a, b) => rank(a) - rank(b));
}

/** The store root: the `libStorePath` config override, else the data-dir default. */
function libStoreRoot(): string {
    return readConfig().libStorePath ?? env.libStorePath;
}

/**
 * Fail fast with an actionable message when the store root exists but is not
 * writable by this user — the signature of a directory the container runtime
 * auto-created (root-owned) when a missing bind source was mounted at sandbox
 * launch. Without this, the first `mkdir`/`open` inside the root surfaces a bare
 * `EACCES` that names neither the cause nor the fix. A not-yet-existing root is
 * fine: the pull creates it, owned by this user.
 */
function ensureStoreRootWritable(root: string): Result<void, PullError> {
    if (!existsSync(root)) return ok(undefined);
    try {
        accessSync(root, constants.W_OK);
        return ok(undefined);
    } catch {
        return err({
            type: "io_failed",
            message: `The library store root ${root} is not writable by this user — often a root-owned directory a container auto-created for a missing bind mount. Remove or take ownership of it (e.g. \`sudo rm -rf ${root}\`), then re-run \`inflexa libs pull\`.`,
        });
    }
}

/**
 * Resolve a track's download URL. Prefer the manifest's store-relative `path`
 * joined onto the RESOLVED base ({@link resolveBaseUrl}), so an
 * `INFLEXA_LIB_STORE_URL`/`libStoreUrl` mirror redirects the payload downloads
 * too — not just the manifest (the air-gapped-mirror case). Fall back to the
 * absolute `url` for a manifest that predates the `path` field.
 */
function trackUrl(base: string, entry: TrackEntry): string {
    return entry.path !== undefined ? `${base}/${entry.path}` : entry.url;
}

/** Flags accepted by `inflexa libs pull` (and reused by setup). */
export type PullOptions = {
    /** Target a specific published version instead of `latest`. */
    readonly version?: string;
    /** Skip the size confirmation (also implied non-interactively). */
    readonly yes?: boolean;
    /** Suppress all interactive UI (confirm/spinner/logs) — used when a caller owns its own spinner. */
    readonly quiet?: boolean;
};

/** The result of a pull, for the caller to report. */
export type PullOutcome =
    | { readonly type: "up_to_date"; readonly version: string }
    | {
          readonly type: "activated";
          readonly version: string;
          readonly downloadedBytes: number;
          readonly reusedTracks: readonly Track[];
      }
    | { readonly type: "declined" };

/**
 * A pull failed. Each variant names one stage of the pull algorithm (arch → manifest
 * → download → verify → extract → assemble/sanity → activate); the message is
 * user-facing and the optional `cause` carries the underlying throw for logs.
 */
export type PullError =
    | { readonly type: "arch_unsupported"; readonly message: string }
    | { readonly type: "manifest_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "download_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "checksum_mismatch"; readonly message: string }
    | { readonly type: "extract_failed"; readonly message: string }
    | { readonly type: "sanity_failed"; readonly message: string }
    /** Another `inflexa` process holds the single-writer store lock; `holderPid` is that pull's pid. Not a fault — the other pull is provisioning the store. */
    | { readonly type: "pull_in_progress"; readonly message: string; readonly holderPid: number }
    | { readonly type: "io_failed"; readonly message: string; readonly cause?: unknown };

function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B";
    const mb = bytes / 1024 / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * Provision the library store. Detects arch, fetches the arch's manifest,
 * plans the download (skipping track digests already held in the dedup cache),
 * confirms the size, downloads missing tracks in parallel with sha256
 * verification, assembles `packages.txt`, and activates atomically. Re-pulling
 * what is already active short-circuits to `up_to_date` with nothing on the wire.
 */
export async function libsPull(opts: PullOptions = {}): Promise<Result<PullOutcome, PullError>> {
    const interactive = !opts.quiet && process.stdin.isTTY;

    const arch = detectArch();
    if (arch === null) {
        return err({ type: "arch_unsupported", message: "Could not map `uname -m` to a supported architecture (expected x86_64 or aarch64)." });
    }
    if (arch === "linux-arm64" && !opts.quiet) log.info(ARM64_NO_R_REASON);

    const base = resolveBaseUrl();
    const url = manifestUrl(base, arch, opts.version);
    const manifestResult = await fetchManifest(url);
    if (manifestResult.isErr()) return err(manifestResult.error);
    const manifest = manifestResult.value;
    const version = manifest.version;

    // Re-pull short-circuit: the active store already equals the resolved
    // manifest's version (for this arch) → nothing to do.
    const root = libStoreRoot();
    const active = (await readActive(root)).unwrapOr(null);
    if (active && active.version === version && active.meta?.arch === arch) {
        return ok({ type: "up_to_date", version });
    }

    // Plan: pin every track the manifest carries. Unknown track names fail loud —
    // this CLI would not know where the subtree belongs (a newer store than the CLI).
    const plan: { track: Track; entry: TrackEntry }[] = [];
    for (const track of canonicalTrackOrder(Object.keys(manifest.tracks))) {
        if (!isKnownTrack(track)) {
            return err({
                type: "manifest_failed",
                message: `Manifest for ${arch} names a track this CLI does not know ("${track}") — update inflexa and retry.`,
            });
        }
        plan.push({ track, entry: manifest.tracks[track]! });
    }
    if (plan.length === 0) {
        return err({ type: "manifest_failed", message: `Manifest for ${arch} pins no tracks — nothing to pull.` });
    }
    const tracks = plan.map((p) => p.track);
    // Single partition pass: `hasBlob` stat()s the dedup cache, so split held vs
    // needed in one sweep rather than filtering the plan twice. The download set is
    // deduped by DIGEST, not by track: the blob path is content-addressed, so two
    // distinct tracks pinning the same sha256 (e.g. two placeholder/empty tarballs)
    // are ONE blob. Queuing both would fire two concurrent `downloadTrack`s writing
    // the same `.part` with independent writers — a verified-but-corrupt interleave.
    // The single content-addressed download satisfies both; the second track still
    // extracts from that blob below (extraction iterates the full plan).
    const reused: Track[] = [];
    const toDownload: { track: Track; entry: TrackEntry }[] = [];
    const queuedDigests = new Set<string>();
    for (const p of plan) {
        if (hasBlob(root, p.entry.sha256)) reused.push(p.track);
        else if (!queuedDigests.has(p.entry.sha256)) {
            queuedDigests.add(p.entry.sha256);
            toDownload.push(p);
        }
    }
    const downloadBytes = toDownload.reduce((sum, p) => sum + p.entry.size, 0);

    if (interactive && !opts.yes && downloadBytes > 0) {
        const proceed = await confirm(`Download ${formatBytes(downloadBytes)} for the sandbox library store (${arch})?`);
        if (!proceed) return ok({ type: "declined" });
    }

    // Before any mutation, reject a root-owned/unwritable store root with an actionable
    // message rather than letting the first mkdir/open below fail on a bare EACCES.
    const writable = ensureStoreRootWritable(root);
    if (writable.isErr()) return err(writable.error);

    // Take the machine-wide pull lock BEFORE any store mutation (but after the size
    // confirm, so it is never held waiting on user input). One pull at a time: a second
    // concurrent pull bows out with `pull_in_progress` instead of racing on shared
    // staging/cache/pointer state. `lib/lock.ts` reclaims a dead holder's lock itself.
    const lock = acquireInstanceLock(LIB_STORE_LOCK_KEY);
    if (!lock.acquired) {
        return err({
            type: "pull_in_progress",
            message: `Another \`inflexa libs pull\` is already running (pid ${lock.holderPid}); it will finish provisioning the store. Skipping this one.`,
            holderPid: lock.holderPid,
        });
    }

    const s = opts.quiet ? null : clackSpinner();
    s?.start(`Provisioning the library store (${formatBytes(downloadBytes)} to download)`);

    // The finally reclaims the staging dir (a harmless no-op after `activate` consumed
    // it) and releases the lock on EVERY exit path, so a failed pull never leaks a
    // multi-GB tree or a held lock.
    let staging: string | null = null;
    try {
        const prep = await prepareStaging(root, version);
        if (prep.isErr()) return finishErr(s, prep.error);
        staging = prep.value;

        // Download the missing tracks in parallel; verified blobs land in the dedup cache.
        const downloads = await Promise.all(toDownload.map((p) => downloadTrack(root, base, p.track, p.entry)));
        for (const d of downloads) {
            if (d.isErr()) return finishErr(s, d.error);
        }

        // Extract every resolved track (held or freshly downloaded) into the staging tree.
        for (const { track, entry } of plan) {
            const ext = await extractTrack(staging, root, track, entry);
            if (ext.isErr()) return finishErr(s, ext.error);
        }

        const assembled = await assemblePackages(staging, tracks);
        if (assembled.isErr()) return finishErr(s, assembled.error);

        // Record each track's source-tarball sha256 so activate compares CONTENT, not
        // just track names: a same-version republish with different bytes then replaces
        // the stale tree instead of silently keeping it (see store.ts sameStoreContent).
        const trackDigests: Record<string, string> = {};
        for (const p of plan) trackDigests[p.track] = p.entry.sha256;

        const metaResult = await writeMeta(staging, { version, arch, tracks, trackDigests });
        if (metaResult.isErr()) return finishErr(s, { type: "io_failed", message: metaResult.error.message });

        const sanity = sanityCheck(staging, tracks, assembled.value);
        if (sanity.isErr()) return finishErr(s, sanity.error);

        const activated = await activate(root, version, staging);
        if (activated.isErr()) return finishErr(s, { type: "io_failed", message: activated.error.message });

        // Prune is best-effort — a failure to reclaim old versions must not fail a
        // completed activation (the store is already correct). Runs under the held lock.
        (await prune(root, KEEP_VERSIONS)).match(
            () => undefined,
            (e) => log.warn(`Could not prune old store versions: ${e.message}`),
        );

        s?.stop(`Library store ready: ${version} (${arch})`);
        return ok({ type: "activated", version, downloadedBytes: downloadBytes, reusedTracks: reused });
    } finally {
        if (staging !== null) await discardStaging(staging);
        releaseInstanceLock(LIB_STORE_LOCK_KEY);
    }
}

/** Stop a spinner (if any) with an error and return the failure. */
function finishErr(s: ReturnType<typeof clackSpinner> | null, error: PullError): Result<PullOutcome, PullError> {
    s?.error("Library store provisioning failed");
    return err(error);
}

/** Create a unique staging dir and return its path (held under the pull lock). */
async function prepareStaging(root: string, version: string): Promise<Result<string, PullError>> {
    try {
        await ensureStoreDirs(root);
        const staging = newStagingDir(root, version);
        await mkdir(staging, { recursive: true });
        return ok(staging);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not prepare the staging directory: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
    }
}

/**
 * Download one track to a `.part` sidecar in the dedup cache, verify its sha256
 * against the manifest, then atomically rename it to its content-addressed blob
 * path. A digest mismatch is loud (`checksum_mismatch`) and the partial file is
 * discarded — `current` is never touched. Held blobs are skipped (0 bytes).
 */
async function downloadTrack(root: string, base: string, track: Track, entry: TrackEntry): Promise<Result<void, PullError>> {
    if (hasBlob(root, entry.sha256)) return ok(undefined); // dedup: already held, nothing on the wire

    const dest = blobPath(root, entry.sha256);
    // Download to a `.part` sidecar, verify the digest, then atomically rename onto the
    // blob path (embedding/setup.ts's discipline). Under the pull lock there is exactly
    // one writer; a crashed pull's orphaned `.part` is swept by prune.
    const part = `${dest}.part`;
    try {
        await mkdir(cacheDir(root), { recursive: true });
        const response = await fetch(trackUrl(base, entry));
        if (!response.ok || response.body === null) {
            return err({ type: "download_failed", message: `Track "${track}" download failed: HTTP ${response.status} ${response.statusText}` });
        }

        const writer = Bun.file(part).writer();
        const hasher = new Bun.CryptoHasher("sha256");
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            hasher.update(value);
            await writer.write(value);
        }
        await writer.end();

        const digest = hasher.digest("hex");
        if (digest !== entry.sha256) {
            await unlink(part).catch(() => {});
            return err({
                type: "checksum_mismatch",
                message: `Track "${track}" sha256 (${digest}) does not match the manifest (${entry.sha256}). The download is corrupt; retry.`,
            });
        }
        await rename(part, dest);
        return ok(undefined);
    } catch (cause) {
        await unlink(part).catch(() => {});
        return err({ type: "download_failed", message: `Track "${track}" download failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
    }
}

/**
 * Extract a track's tarball (zstd-compressed) at the STAGING ROOT. The producer
 * (`scripts/lib-store-pack.sh`, via `lib_store_track_members`) packs each track
 * with its subtree already prefixed (`r/cran/…`) PLUS a root-level
 * `<track>.packages.txt` fragment, so extracting at the root reproduces the store
 * layout — `<version>/r/cran/…` and `<version>/<track>.packages.txt` — that both
 * `harness/src/sandbox/mount-plan.ts` (R_LIBS_SITE/NODE_PATH/PATH) and
 * {@link assemblePackages} depend on. Extracting into `TRACK_SUBTREE[track]/`
 * instead would double-nest the subtree (`r/cran/r/cran/…`) and hide the fragment.
 */
async function extractTrack(staging: string, root: string, track: Track, entry: TrackEntry): Promise<Result<void, PullError>> {
    try {
        await mkdir(staging, { recursive: true });
        const proc = Bun.spawn(["tar", "--zstd", "-xf", blobPath(root, entry.sha256), "-C", staging], { stdout: "ignore", stderr: "pipe" });
        const code = await proc.exited;
        if (code !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return err({ type: "extract_failed", message: `Could not extract track "${track}": tar exited ${code}${stderr ? ` — ${stderr.trim()}` : ""}` });
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "extract_failed", message: `Could not extract track "${track}": ${cause instanceof Error ? cause.message : String(cause)}` });
    }
}

/**
 * Assemble `packages.txt` from exactly the pulled tracks' fragments — each track's
 * tarball carries a root-level `<track>.packages.txt` (see {@link trackFragmentFile})
 * — beneath the shared advisory {@link PACKAGES_TXT_HEADER}, in the canonical
 * {@link PACKAGES_TXT_CONCAT_ORDER} with a blank line after each fragment. This is
 * byte-for-byte what the local/offline shell assembler (`scripts/lib-store-assemble.sh`)
 * writes for the same fragments, so a store is identical however it was produced.
 * We NEVER synthesize the list from a manifest wishlist: the file must reflect what
 * was actually pulled (an arm64 store therefore advertises no R packages). A pulled
 * track missing its fragment is `sanity_failed`, not skipped — silently dropping one
 * would let a full pull under-advertise (e.g. no R packages) while still passing the
 * non-empty check. Returns the assembled package count (header/section comment lines
 * excluded).
 */
async function assemblePackages(staging: string, tracks: readonly Track[]): Promise<Result<number, PullError>> {
    try {
        const ordered = canonicalTrackOrder(tracks) as Track[];

        const fragments: string[] = [];
        for (const track of ordered) {
            const frag = join(staging, trackFragmentFile(track));
            if (!existsSync(frag)) {
                return err({ type: "sanity_failed", message: `Track "${track}" carries no packages.txt fragment after extraction.` });
            }
            // Trailing "\n" per fragment mirrors the shell assembler's `cat frag; echo`.
            fragments.push(`${await Bun.file(frag).text()}\n`);
        }
        const text = PACKAGES_TXT_HEADER + fragments.join("");
        await writeFile(join(staging, "packages.txt"), text);
        return ok(countPackages(text));
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not assemble packages.txt: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
    }
}

/**
 * Count advertised packages in an assembled `packages.txt`. Each ecosystem's
 * fragment lists its packages as a single COMMA-joined line under a `## Section`
 * heading, so the count is the number of comma-separated tokens across all
 * non-blank, non-comment lines — matching `validate.py`'s `line.split(",")` parse
 * (counting whole lines would report roughly one-per-section, e.g. "6 advertised"
 * instead of the real hundreds). Exported for the status display and its unit test.
 */
export function countPackages(text: string): number {
    let count = 0;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        for (const token of trimmed.split(",")) {
            if (token.trim() !== "") count += 1;
        }
    }
    return count;
}

/** Cheap, local pre-activation sanity: packages.txt non-empty and every track subtree present. */
function sanityCheck(staging: string, tracks: readonly Track[], packageCount: number): Result<void, PullError> {
    if (packageCount === 0) {
        return err({ type: "sanity_failed", message: "Assembled packages.txt is empty — the pulled tracks carried no package list." });
    }
    for (const track of tracks) {
        if (!existsSync(join(staging, TRACK_SUBTREE[track]))) {
            return err({ type: "sanity_failed", message: `Expected subtree "${TRACK_SUBTREE[track]}" for track "${track}" is missing after extraction.` });
        }
    }
    return ok(undefined);
}

// --- status ------------------------------------------------------------------

/** `inflexa libs status` — location, active version/arch, present tracks, count, up-to-date. */
export async function libsStatus(): Promise<void> {
    const root = libStoreRoot();
    const active = (await readActive(root)).unwrapOr(null);

    console.log(`  Store   ${root}`);
    if (active === null) {
        console.log("  No library store installed.");
        console.log("  Run `inflexa libs pull` to download it.");
        return;
    }

    const meta = active.meta;
    if (meta) {
        console.log(`  Active  ${active.version}  (${meta.arch})`);
        const present = meta.tracks.filter((t) => existsSync(join(active.versionDir, TRACK_SUBTREE[t])));
        console.log(`  Tracks  ${present.join(", ") || "(none present)"}`);
    } else {
        console.log(`  Active  ${active.version}  (metadata unavailable)`);
    }

    const packagesFile = join(active.versionDir, "packages.txt");
    if (existsSync(packagesFile)) {
        const count = countPackages(await Bun.file(packagesFile).text());
        console.log(`  Packages ${count.toLocaleString()} advertised`);
    }

    // Up-to-date check is best-effort — an offline machine still gets a status.
    if (meta) {
        const base = resolveBaseUrl();
        const latest = await fetchManifest(manifestUrl(base, meta.arch), AbortSignal.timeout(MANIFEST_PROBE_TIMEOUT_MS));
        latest.match(
            (m) =>
                console.log(
                    m.version === active.version
                        ? `  Up to date  (latest = ${m.version})`
                        : `  Update available  (latest = ${m.version}; run \`inflexa libs pull\`)`,
                ),
            () => console.log("  Latest      (could not reach the store to check)"),
        );
    }
}

// --- pre-launch lazy offer -------------------------------------------------

/**
 * Before a sandbox launch, when no store is active, print a one-line actionable
 * offer to run `inflexa libs pull` (with an approximate size). This is an OFFER,
 * never a blocker: a missing store is degraded, not broken — the harness returns
 * `available:false` and the launch proceeds. Must never throw OR block: it is
 * skipped entirely off a TTY (the printed offer is noise a script cannot act on),
 * and the size-probe manifest fetch is bounded by {@link MANIFEST_PROBE_TIMEOUT_MS}
 * so a blackholed store host cannot stall boot — on any failure the size hint is
 * dropped and the offer still prints.
 */
export async function offerLibStoreIfMissing(): Promise<void> {
    // Off a TTY the offer is useless (piped/redirected output, CI) — skip it wholesale.
    if (!process.stdout.isTTY) return;

    const root = libStoreRoot();
    const active = (await readActive(root)).unwrapOr(null);
    if (active !== null) return;

    let size = "";
    const arch = detectArch();
    if (arch !== null) {
        const base = resolveBaseUrl();
        const manifest = await fetchManifest(manifestUrl(base, arch), AbortSignal.timeout(MANIFEST_PROBE_TIMEOUT_MS)).then(
            (r) => r.unwrapOr(null),
            () => null,
        );
        if (manifest) size = ` (~${formatBytes(estimateSize(manifest))})`;
    }
    console.log(`\n  No library store installed${size}. Analysis code may not find R/Python packages.`);
    console.log("  Run `inflexa libs pull` to provision it (optional — the run continues without it).\n");
}

function estimateSize(manifest: Manifest): number {
    return Object.values(manifest.tracks).reduce((sum, e) => sum + e.size, 0);
}
