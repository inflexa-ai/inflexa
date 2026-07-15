/**
 * Local-embedding sidecar runtime acquisition: materialize the pinned `llama.cpp`
 * release archive (the `llama-server` binary plus its companion shared libraries)
 * into a tag-named directory under the data dir, source-aware and atomic.
 *
 * Why an external prebuilt runtime at all: the compiled single-file binary cannot
 * carry a native inference addon (nothing native reads `/$bunfs`), and `llama.cpp`
 * churns its C ABI daily. Shipping the official `llama-server` release and talking
 * to it over loopback HTTP insulates the product from that churn — the sidecar is
 * just another OpenAI-shaped `baseURL` for the harness embedding provider.
 *
 * Two byte sources converge on ONE materialization step:
 *   - compiled binary → the archive is a build-time embedded asset (each target
 *     embeds exactly its own, selected by a per-target `--define`; see
 *     {@link embeddedArchivePath} and scripts/build.ts), extracted in place, never
 *     read by native code from `/$bunfs`.
 *   - from source → the identical pinned artifact is downloaded from the release.
 * Both then: verify SHA-256 → extract the FULL archive dir (the server resolves its
 * `@rpath`/`@loader_path` dylibs relative to itself, so the whole dir must ship
 * together) → atomically rename into `<env.llamaServerDir>/<tag>/`. A partial or
 * failed run leaves nothing at the final path; an already-materialized tag dir is
 * reused with no network, hashing, or extraction. The tag-named directory makes a
 * pin bump a self-cleaning upgrade (new tag → new dir; old dirs are sweepable).
 */

import { randomUUIDv7 } from "bun";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { env } from "../../lib/env.ts";
import { isCompiledBinary } from "../../lib/install_context.ts";

/**
 * Failure modes of runtime acquisition, kept as narrow as the seam needs. Every
 * message carries actionable remediation; `cause` preserves the underlying throw
 * for diagnostics without leaking it into the discriminant.
 */
export type LlamaRuntimeError = {
    readonly type: "download_failed" | "hash_mismatch" | "extract_failed" | "io_failed";
    readonly message: string;
    readonly cause?: unknown;
};

/** The four release targets we pin (matches scripts/build.ts's compile matrix). */
export type LlamaTargetKey = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64";

/** A per-target pin entry: the release artifact filename and its vendored SHA-256. */
export type LlamaPin = {
    readonly target: LlamaTargetKey;
    /** The release asset filename, e.g. `llama-b9310-bin-macos-arm64.tar.gz`. */
    readonly artifact: string;
    /** SHA-256 of the artifact, computed from the actual download (upstream publishes none). */
    readonly sha256: string;
};

/** A {@link LlamaPin} resolved for the active tag — the shape materialization and tests operate on. */
export type ResolvedPin = LlamaPin & {
    /** The pinned release tag, e.g. `b9310`. Also the name of the materialized runtime directory. */
    readonly tag: string;
};

/**
 * The pinned `llama.cpp` release tag, shared by every platform.
 *
 * WHY b9310 (cut 2026-05-25) and not `latest`: upstream cuts releases many times a
 * day with no stability channel, and — decisively — every macOS build published
 * after 2026-05-29 carries `LC_BUILD_VERSION minos 26.0` and REFUSES to load on
 * macOS 14/15. b9310's `llama-server` is `minos 14.0` (verified with `otool -l`
 * before vendoring), so it runs on the macOS versions the product supports. A
 * stale-but-working pin costs nothing here because the HTTP/subprocess boundary
 * decouples us from the runtime's version.
 *
 * TO BUMP THE PIN (a deliberate, reviewed act):
 *   1. Pick a new tag whose macOS builds are `minos 14.x` (confirm:
 *      `otool -l llama-server | grep -A2 LC_BUILD_VERSION`).
 *   2. Download all four artifacts below, `shasum -a 256` each, and update
 *      {@link LLAMA_RUNTIME_TAG}, every {@link LLAMA_PINS} `artifact` + `sha256`,
 *      AND the four string-literal import specifiers in {@link embeddedArchivePath}
 *      (Bun can only embed statically-known paths, so those literals cannot be
 *      derived from the constants — they must be edited in lockstep).
 *   3. Confirm `llama-server` (`llama-server.exe` on Windows) exists in each
 *      archive; the macOS/Linux tarballs nest it under a single `llama-<tag>/`
 *      dir, the Windows zip is flat.
 */
export const LLAMA_RUNTIME_TAG = "b9310";

/** Base URL for `ggml-org/llama.cpp` release downloads; the tag + artifact complete it. */
export const LLAMA_RELEASE_DOWNLOAD_BASE = "https://github.com/ggml-org/llama.cpp/releases/download";

/**
 * The per-target pin: artifact filename + vendored SHA-256, the SOLE integrity
 * authority (upstream ships no checksums). Windows uses a `.zip`; the rest use
 * `.tar.gz`. Hashes computed from the actual b9310 downloads. Keyed by the same
 * `<os>-<arch>` string scripts/build.ts derives from its target matrix and bakes
 * into `__INFLEXA_LLAMA_TARGET__`, so the build-time and runtime views agree.
 */
export const LLAMA_PINS = {
    "darwin-arm64": {
        target: "darwin-arm64",
        artifact: "llama-b9310-bin-macos-arm64.tar.gz",
        sha256: "71d7e57aff33de7fdde15b0418c254c9ac6cb087a7252ff4034dd0ef99c9d3f9",
    },
    "darwin-x64": {
        target: "darwin-x64",
        artifact: "llama-b9310-bin-macos-x64.tar.gz",
        sha256: "32fe81c748bf6630a4794464a72236f0050126516dc9c560299be59c37d0b99b",
    },
    "linux-x64": {
        target: "linux-x64",
        artifact: "llama-b9310-bin-ubuntu-x64.tar.gz",
        sha256: "26af63e3578c394fa53dd9967098beddd4b9719b2ee33cf8eb72ed0d17e68ef9",
    },
    "linux-arm64": {
        target: "linux-arm64",
        artifact: "llama-b9310-bin-ubuntu-arm64.tar.gz",
        sha256: "9b4f1b74a229c31373b75b06bbeee77c8b77e351e5693499da6311e070f95abf",
    },
    "windows-x64": {
        target: "windows-x64",
        artifact: "llama-b9310-bin-win-cpu-x64.zip",
        sha256: "2fee9dd5a43a18efdc96ab2b09e6a6ede8ba8df54dfac1dbf56aa026524c99c8",
    },
} as const satisfies Record<LlamaTargetKey, LlamaPin>;

/** The release download URL for `pin` at `tag`. */
export function llamaArtifactUrl(tag: string, pin: LlamaPin): string {
    return `${LLAMA_RELEASE_DOWNLOAD_BASE}/${tag}/${pin.artifact}`;
}

/**
 * Per-target compile-time constant naming which platform's archive this binary
 * embedded. scripts/build.ts `--define`s it (e.g. `"darwin-arm64"`) per target; a
 * from-source / dev / test run leaves it undeclared, which the `typeof` guards in
 * {@link embeddedArchivePath} fold to "no embedded asset". Same define-gating trick
 * install_context.ts uses for `__INFLEXA_COMPILED__`, extended to a per-target
 * string so the bundler eliminates every non-matching branch — and with it the
 * `import(... with { type: "file" })` inside — leaving each binary carrying EXACTLY
 * its own ~10 MB archive instead of all four.
 */
declare const __INFLEXA_LLAMA_TARGET__: string | undefined;

/** Which byte source materialization pulled the archive from. */
type LlamaSource = "embedded" | "download";

/**
 * Acquire the archive bytes into `destPath`. Real implementation branches on the
 * install context; a test override (see {@link __setLlamaAcquireForTest}) can stub
 * both branches and observe which `source` was chosen.
 */
type LlamaAcquire = (source: LlamaSource, destPath: string, pin: ResolvedPin) => Promise<Result<void, LlamaRuntimeError>>;

// Module-level test seams (mirroring install_context's __set…ForTest): a forced pin
// lets a unit test drive the whole pipeline against a fixture tag/hash without the
// real network or embedded asset; a forced acquire supplies fixture bytes and records
// the source. Both `null` in production. The in-flight promise coalesces concurrent
// first calls (a batch embed) onto one materialize and is cleared on settle so a
// failed attempt can be retried.
let pinOverride: ResolvedPin | null = null;
let acquireOverride: LlamaAcquire | null = null;
let inFlight: Promise<Result<string, LlamaRuntimeError>> | null = null;

function errText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/** The server binary's filename on the ACTIVE runtime platform (`.exe` on Windows). */
function serverBinaryName(): string {
    return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

/** Map the active `process.platform`/`process.arch` to a pinned target, or `null` if unsupported. */
function currentTargetKey(): LlamaTargetKey | null {
    const os = process.platform === "win32" ? "windows" : process.platform;
    switch (`${os}-${process.arch}`) {
        case "darwin-arm64":
            return "darwin-arm64";
        case "darwin-x64":
            return "darwin-x64";
        case "linux-x64":
            return "linux-x64";
        case "linux-arm64":
            return "linux-arm64";
        case "windows-x64":
            return "windows-x64";
        default:
            return null;
    }
}

/** The pin for the active platform+tag, honoring a test override; `null` on an unsupported platform. */
function resolvePin(): ResolvedPin | null {
    if (pinOverride !== null) return pinOverride;
    const key = currentTargetKey();
    if (key === null) return null;
    return { tag: LLAMA_RUNTIME_TAG, ...LLAMA_PINS[key] };
}

/**
 * The compiled binary's embedded archive path for the current target, or `null`
 * when nothing was embedded (from-source / dev / test).
 *
 * Each comparison folds to a compile-time boolean under the per-target
 * `__INFLEXA_LLAMA_TARGET__` define, so the bundler keeps ONLY the matching
 * branch's `import(... with { type: "file" })` and drops the other three — the
 * mechanism that embeds exactly one archive per target and lets a host-only
 * `bun run build` cache just that target's artifact. The `typeof` guard keeps a
 * from-source run (where the define never ran, so the identifier is genuinely
 * undeclared) from a ReferenceError. The specifiers point at the out-of-git
 * `.llama-cache/` that scripts/build.ts populates before compiling; the literals
 * must be edited in lockstep with the pin (see {@link LLAMA_RUNTIME_TAG}).
 */
async function embeddedArchivePath(): Promise<string | null> {
    if (typeof __INFLEXA_LLAMA_TARGET__ !== "undefined" && __INFLEXA_LLAMA_TARGET__ === "darwin-arm64") {
        return (await import("../../../.llama-cache/llama-b9310-bin-macos-arm64.tar.gz", { with: { type: "file" } })).default;
    }
    if (typeof __INFLEXA_LLAMA_TARGET__ !== "undefined" && __INFLEXA_LLAMA_TARGET__ === "darwin-x64") {
        return (await import("../../../.llama-cache/llama-b9310-bin-macos-x64.tar.gz", { with: { type: "file" } })).default;
    }
    if (typeof __INFLEXA_LLAMA_TARGET__ !== "undefined" && __INFLEXA_LLAMA_TARGET__ === "linux-x64") {
        return (await import("../../../.llama-cache/llama-b9310-bin-ubuntu-x64.tar.gz", { with: { type: "file" } })).default;
    }
    if (typeof __INFLEXA_LLAMA_TARGET__ !== "undefined" && __INFLEXA_LLAMA_TARGET__ === "linux-arm64") {
        return (await import("../../../.llama-cache/llama-b9310-bin-ubuntu-arm64.tar.gz", { with: { type: "file" } })).default;
    }
    if (typeof __INFLEXA_LLAMA_TARGET__ !== "undefined" && __INFLEXA_LLAMA_TARGET__ === "windows-x64") {
        return (await import("../../../.llama-cache/llama-b9310-bin-win-cpu-x64.zip", { with: { type: "file" } })).default;
    }
    return null;
}

/** Copy the embedded archive to `destPath` using bunfs-safe reads (fd-based APIs ENOENT on `/$bunfs`). */
async function writeEmbeddedArchive(destPath: string): Promise<Result<void, LlamaRuntimeError>> {
    const assetPath = await embeddedArchivePath();
    if (assetPath === null) {
        return err({
            type: "io_failed",
            message: `This inflexa binary did not embed a llama-server runtime for ${process.platform}-${process.arch}. Reinstall the official binary for your platform, or run inflexa from source.`,
        });
    }
    try {
        // Bun.file().bytes() mmaps the embedded segment; Bun.write() lands it on a real disk path.
        // Neither uses a file descriptor into /$bunfs, which is the constraint that rules out
        // createReadStream / copyFileSync here.
        const bytes = await Bun.file(assetPath).bytes();
        await Bun.write(destPath, bytes);
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not read the embedded llama-server archive: ${errText(cause)}`, cause });
    }
}

/** Stream the pinned artifact to `destPath`. Any network/HTTP fault is `download_failed`, never thrown. */
async function downloadArchive(destPath: string, pin: ResolvedPin): Promise<Result<void, LlamaRuntimeError>> {
    const url = llamaArtifactUrl(pin.tag, pin);
    try {
        const response = await fetch(url);
        if (!response.ok || response.body === null) {
            return err({
                type: "download_failed",
                message: `Downloading the llama-server runtime failed: HTTP ${response.status} ${response.statusText} from ${url}. Check your network path to github.com and retry \`inflexa setup --embeddings local\`.`,
            });
        }
        const writer = Bun.file(destPath).writer();
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
        }
        await writer.end();
        return ok(undefined);
    } catch (cause) {
        return err({
            type: "download_failed",
            message: `Downloading the llama-server runtime failed: ${errText(cause)}. Retry \`inflexa setup --embeddings local\`.`,
            cause,
        });
    }
}

/** Route acquisition by install context (embedded vs download), or defer to a test override. */
function acquireArchive(source: LlamaSource, destPath: string, pin: ResolvedPin): Promise<Result<void, LlamaRuntimeError>> {
    if (acquireOverride !== null) return acquireOverride(source, destPath, pin);
    if (source === "embedded") return writeEmbeddedArchive(destPath);
    return downloadArchive(destPath, pin);
}

/** Verify the on-disk archive matches the vendored SHA-256. A mismatch is fatal (nothing installed). */
async function verifyArchiveHash(archivePath: string, expected: string): Promise<Result<void, LlamaRuntimeError>> {
    try {
        const bytes = await Bun.file(archivePath).bytes();
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        if (digest !== expected) {
            return err({
                type: "hash_mismatch",
                message: `The llama-server runtime archive failed integrity verification (sha256 ${digest}, expected ${expected}). The pinned release may have been re-cut or the download corrupted; nothing was installed. Retry, or check your network path to github.com.`,
            });
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not hash the llama-server archive: ${errText(cause)}`, cause });
    }
}

/**
 * Extract `archivePath` into `destDir` via the system `tar`. bsdtar (macOS,
 * Windows 10+) auto-detects BOTH gzip and zip; GNU tar (Linux) auto-detects gzip —
 * and each runtime platform only ever extracts its own artifact kind (Linux never
 * sees the Windows zip), so a single `tar -xf` covers every pair we ship.
 */
async function extractArchive(archivePath: string, destDir: string): Promise<Result<void, LlamaRuntimeError>> {
    try {
        await mkdir(destDir, { recursive: true });
        const proc = Bun.spawn(["tar", "-xf", archivePath, "-C", destDir], { stdout: "ignore", stderr: "pipe" });
        const code = await proc.exited;
        if (code !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return err({
                type: "extract_failed",
                message: `Extracting the llama-server archive failed (tar exit ${code})${stderr ? `: ${stderr.trim()}` : ""}.`,
            });
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "extract_failed", message: `Extracting the llama-server archive failed: ${errText(cause)}`, cause });
    }
}

/**
 * Find the directory that directly contains `llama-server` after extraction. The
 * macOS/Linux tarballs nest it under a single `llama-<tag>/` dir; the Windows zip
 * is flat. So: a single top-level entry that is a directory IS the runtime root
 * (descend into it); anything else means the flat layout and `stageDir` is the
 * root. A missing server binary means the pinned artifact's layout changed.
 */
function locateRuntimeRoot(stageDir: string): Result<string, LlamaRuntimeError> {
    let root = stageDir;
    try {
        const entries = readdirSync(stageDir);
        if (entries.length === 1) {
            const only = join(stageDir, entries[0]!);
            if (statSync(only).isDirectory()) root = only;
        }
    } catch (cause) {
        return err({ type: "extract_failed", message: `Could not inspect the extracted llama-server archive: ${errText(cause)}`, cause });
    }
    if (!existsSync(join(root, serverBinaryName()))) {
        return err({
            type: "extract_failed",
            message: `The extracted llama-server archive did not contain ${serverBinaryName()}; the pinned artifact layout may have changed.`,
        });
    }
    return ok(root);
}

/**
 * The pinned tag's `llama-server` binary path when the runtime is materialized,
 * else `null`. A cheap existence check only — NO hashing — so the hot-path
 * readiness gate can call it cheaply. Honors a test pin override.
 */
export function materializedLlamaServer(): string | null {
    const pin = resolvePin();
    if (pin === null) return null;
    const serverPath = join(env.llamaServerDir, pin.tag, serverBinaryName());
    return existsSync(serverPath) ? serverPath : null;
}

/**
 * The whole acquisition pipeline for one attempt: stage in a temp dir on the SAME
 * filesystem as the final path (so the closing rename is atomic), acquire → verify
 * → extract → locate → atomic-rename into the tag dir. Any failure cleans the temp
 * dir, leaving nothing at the final path.
 */
async function materialize(): Promise<Result<string, LlamaRuntimeError>> {
    const pin = resolvePin();
    if (pin === null) {
        return err({
            type: "io_failed",
            message: `Local embeddings have no pinned llama-server runtime for ${process.platform}-${process.arch}. Supported: macOS (arm64/x64), Linux x64, Windows x64. Use \`embedding.mode = "api-key"\` or \`"off"\` instead.`,
        });
    }

    const finalDir = join(env.llamaServerDir, pin.tag);
    const serverName = serverBinaryName();

    // Stage UNDER llamaServerDir (not tmpdir()) so the closing rename stays intra-filesystem and thus
    // atomic; a cross-device rename would silently degrade to copy+unlink, breaking the "nothing
    // partial at the final path" guarantee.
    let tmpRoot: string;
    try {
        await mkdir(env.llamaServerDir, { recursive: true });
        tmpRoot = join(env.llamaServerDir, `.tmp-${randomUUIDv7()}`);
        await mkdir(tmpRoot, { recursive: true });
    } catch (cause) {
        return err({
            type: "io_failed",
            message: `Could not prepare the llama-server runtime directory under ${env.llamaServerDir}: ${errText(cause)}`,
            cause,
        });
    }

    const cleanup = async (): Promise<void> => {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    };

    const source: LlamaSource = isCompiledBinary() ? "embedded" : "download";
    const archivePath = join(tmpRoot, pin.artifact);

    const acquired = await acquireArchive(source, archivePath, pin);
    if (acquired.isErr()) {
        await cleanup();
        return err(acquired.error);
    }

    const verified = await verifyArchiveHash(archivePath, pin.sha256);
    if (verified.isErr()) {
        await cleanup();
        return err(verified.error);
    }

    const stageDir = join(tmpRoot, "stage");
    const extracted = await extractArchive(archivePath, stageDir);
    if (extracted.isErr()) {
        await cleanup();
        return err(extracted.error);
    }

    const located = locateRuntimeRoot(stageDir);
    if (located.isErr()) {
        await cleanup();
        return err(located.error);
    }
    const root = located.value;

    // Guarantee the executable bit (spec: it must survive extraction). tar preserves mode on the
    // platforms we ship, but a defensive chmod costs nothing and covers a stripped umask; harmless on
    // Windows. Non-fatal — a chmod hiccup must not wedge an otherwise-good runtime.
    try {
        chmodSync(join(root, serverName), 0o755);
    } catch {
        /* already 0755, or a Windows no-op */
    }

    try {
        await rename(root, finalDir);
    } catch (cause) {
        await cleanup();
        // Lost a race to a concurrent materializer? If the final dir now holds the server, that is
        // success — the point is an idempotent, tag-named directory, not who won. Otherwise propagate.
        const winner = join(finalDir, serverName);
        if (existsSync(winner)) return ok(winner);
        return err({ type: "io_failed", message: `Could not install the llama-server runtime into ${finalDir}: ${errText(cause)}`, cause });
    }

    await cleanup();
    return ok(join(finalDir, serverName));
}

/**
 * Idempotently materialize the pinned runtime and return the absolute
 * `llama-server` binary path. An already-materialized tag directory short-circuits
 * with no network, hashing, or extraction. Concurrent first calls coalesce onto a
 * single materialize; the cache is cleared on settle so a failed attempt can be
 * retried. All failures are on the `Result` channel with actionable remediation.
 */
export function ensureLlamaServer(): Promise<Result<string, LlamaRuntimeError>> {
    const existing = materializedLlamaServer();
    if (existing !== null) return Promise.resolve(ok(existing));
    if (inFlight !== null) return inFlight;
    inFlight = materialize().finally(() => {
        inFlight = null;
    });
    return inFlight;
}

/**
 * TEST ONLY. Force the resolved pin (tag / artifact / sha256) so a unit test can
 * drive the full pipeline against a fixture archive it generated, or `null` to
 * restore real platform detection. Production code never calls it.
 */
export function __setLlamaPinForTest(pin: ResolvedPin | null): void {
    pinOverride = pin;
}

/**
 * TEST ONLY. Replace the byte-acquisition step so a unit test supplies fixture
 * bytes and observes which source (`"embedded"` / `"download"`) the install
 * context selected, or `null` to restore the real embedded/download branches.
 * The real network and embedded assets are never touched under an override.
 */
export function __setLlamaAcquireForTest(fn: LlamaAcquire | null): void {
    acquireOverride = fn;
}

/** TEST ONLY. Reset every module-level seam (overrides + the in-flight coalescing cache). */
export function __resetLlamaRuntimeForTest(): void {
    pinOverride = null;
    acquireOverride = null;
    inFlight = null;
}
