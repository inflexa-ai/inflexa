import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { sha256File } from "../../lib/hash.ts";
import { instanceLockPath } from "../../lib/lock.ts";
import { detectArch, TRACK_SUBTREE, type Track } from "./bundles.ts";
import { type TrackEntry } from "./manifest.ts";
import { countPackages, libsPull } from "./pull.ts";
import { readActive } from "./store.ts";

/** Names of leftover `.staging-*` dirs under a store root (none should remain after a clean pull). */
async function stagingLeftovers(root: string): Promise<string[]> {
    return (await readdir(root)).filter((n) => n.startsWith(".staging-"));
}

// The test preload sandboxes XDG_DATA_HOME/XDG_CONFIG_HOME, so env.configPath is a
// temp file — safe to write per-test config (libStorePath/libStoreUrl) into it.

// Extraction runs real `tar --zstd` on the host, so the host arch IS the fixture
// arch. Test hosts (dev + CI) are linux; a null would 404 every fixture request,
// failing the suite loudly rather than silently skipping it.
const arch = detectArch() ?? "linux-amd64";

/** Track sets mirroring bundles.ts (deliberately restated: the values are the contract under test). */
const CORE_TRACKS: readonly Track[] = ["python", "conda", "node"];
const FULL_TRACKS: readonly Track[] = ["python", "conda", "node", "cran", "bioconductor", "github"];
/** User bundle → published manifest URL segment (the contract from design.md). */
const MANIFEST_BUNDLE = { core: "python-conda", full: "python-r-conda" } as const;

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
/** The fixture "bucket" the server serves; recreated per test. */
let publishDir: string;
/** Per-test store root, isolated via the `libStorePath` config override. */
let storeRoot: string;
/** Request paths the fixture server saw — lets tests assert "nothing on the wire". */
let requests: string[];

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        async fetch(req: Request): Promise<Response> {
            const path = new URL(req.url).pathname;
            requests.push(path);
            const file = Bun.file(join(publishDir, path));
            return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
        },
    });
    baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
    await server.stop(true);
});

beforeEach(async () => {
    publishDir = await mkdtemp(join(tmpdir(), "libpublish-"));
    storeRoot = await mkdtemp(join(tmpdir(), "libpull-"));
    requests = [];
    writeConfig({
        telemetry: false,
        theme: "tokyo-night",
        runtime: "docker",
        leaderTimeout: 2000,
        embedding: { mode: "off" },
        libStorePath: storeRoot,
        libStoreUrl: baseUrl,
    })._unsafeUnwrap();
});

afterEach(async () => {
    await rm(publishDir, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(env.configPath, { force: true });
});

/** The packages.txt fragment a fixture track carries (version-stamped so digests differ across versions). */
function fragment(track: Track, version: string): string {
    return `${track}:pkg-a@${version}\n${track}:pkg-b@${version}\n`;
}

/** The advisory header the pull handler prepends to packages.txt (kept byte-identical to PACKAGES_TXT_HEADER in pull.ts). */
const PACKAGES_TXT_HEADER =
    "# Available packages in the sandbox environment.\n" + "# Do NOT attempt to install packages — there is no network access and no build toolchain.\n" + "\n";

/** Canonical section order — mirrors PACKAGES_TXT_CONCAT_ORDER in pull.ts (and LIB_STORE_CONCAT_ORDER in the shell). */
const CONCAT_ORDER: readonly Track[] = ["cran", "bioconductor", "github", "python", "conda", "node"];

/**
 * The packages.txt the handler must produce: the advisory header, then each pulled
 * track's fragment in canonical order, each followed by a blank line (the shell
 * assembler's `cat frag; echo`). Byte-identical to `scripts/lib-store-assemble.sh`.
 */
function assembledPackages(tracks: readonly Track[], version: string): string {
    const ordered = CONCAT_ORDER.filter((t) => tracks.includes(t));
    return PACKAGES_TXT_HEADER + ordered.map((t) => `${fragment(t, version)}\n`).join("");
}

type PublishOptions = {
    /** Publish this track's manifest entry with a wrong sha256 (the tarball itself is intact). */
    readonly tamperSha?: Track;
    /** Build this track's tarball WITHOUT its packages.txt fragment. */
    readonly omitFragment?: Track;
    /**
     * Point every entry's ABSOLUTE `url` at an unreachable host while keeping the relative
     * `path` correct. A pull can then only succeed by resolving `path` against the configured
     * mirror base (finding 5) — proving the payload honors the mirror, not the baked url.
     */
    readonly deadUrls?: boolean;
};

/**
 * Publish a fixture version to the local "bucket": one zstd tarball per track a
 * requested bundle needs, plus a `latest` manifest per bundle pinning url/sha256/size.
 */
async function publishVersion(version: string, bundles: readonly ("core" | "full")[], opts: PublishOptions = {}): Promise<void> {
    const tracks = bundles.includes("full") ? FULL_TRACKS : CORE_TRACKS;

    const entries: Partial<Record<Track, TrackEntry>> = {};
    for (const track of tracks) {
        // Mirror the PRODUCER tarball layout (scripts/lib-store-pack.sh, via
        // lib_store_track_members): each track packs its SUBTREE already prefixed
        // (e.g. `r/cran/…`) PLUS a ROOT-LEVEL `<track>.packages.txt` fragment — NOT a
        // flat `packages.txt`. The CLI extracts at the store root, so this is the exact
        // shape the consumer must handle; a wrong fixture layout would hide finding 1.
        const src = await mkdtemp(join(tmpdir(), "libtrack-"));
        const subtree = TRACK_SUBTREE[track];
        await mkdir(join(src, subtree), { recursive: true });
        await writeFile(join(src, subtree, "payload.bin"), `payload ${track}@${version}`);
        const members = [subtree];
        if (opts.omitFragment !== track) {
            await writeFile(join(src, `${track}.packages.txt`), fragment(track, version));
            members.push(`${track}.packages.txt`);
        }

        const tarball = join(publishDir, version, arch, `${track}.tar.zst`);
        await mkdir(join(publishDir, version, arch), { recursive: true });
        const proc = Bun.spawn(["tar", "--zstd", "-cf", tarball, "-C", src, ...members], { stdout: "ignore", stderr: "inherit" });
        expect(await proc.exited).toBe(0);
        await rm(src, { recursive: true, force: true });

        const sha256 =
            opts.tamperSha === track
                ? new Bun.CryptoHasher("sha256").update("not-the-published-bytes").digest("hex")
                : (await sha256File(tarball))._unsafeUnwrap();
        // Mirror the producer: emit a store-relative `path` (what the CLI joins onto the
        // resolved base) plus an absolute `url`. `deadUrls` sends the url to an unreachable
        // host so only the path+mirror-base resolution can complete the pull.
        const path = `${version}/${arch}/${track}.tar.zst`;
        const url = opts.deadUrls ? `http://127.0.0.1:1/${path}` : `${baseUrl}/${path}`;
        entries[track] = { path, url, sha256, size: Bun.file(tarball).size };
    }

    for (const bundle of bundles) {
        const bundleTracks = bundle === "full" ? FULL_TRACKS : CORE_TRACKS;
        const manifest = { version, tracks: Object.fromEntries(bundleTracks.map((t) => [t, entries[t]])) };
        const manifestPath = join(publishDir, "latest", MANIFEST_BUNDLE[bundle], arch, "manifest.json");
        await mkdir(join(publishDir, "latest", MANIFEST_BUNDLE[bundle], arch), { recursive: true });
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }
}

describe("libsPull against a local published store", () => {
    test("assembled packages.txt is the advisory header plus the concatenation of the pulled tracks' fragments", async () => {
        await publishVersion("2026.07.04-aaa", ["core"]);

        const outcome = (await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap();
        expect(outcome.type).toBe("activated");

        const expected = assembledPackages(CORE_TRACKS, "2026.07.04-aaa");
        expect(await Bun.file(join(storeRoot, "current", "packages.txt")).text()).toBe(expected);
    }, 20_000);

    test("re-pull when already up to date is a no-op with nothing on the wire", async () => {
        await publishVersion("2026.07.04-aaa", ["core"]);
        expect((await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap().type).toBe("activated");

        requests = [];
        const outcome = (await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap();
        expect(outcome).toEqual({ type: "up_to_date", version: "2026.07.04-aaa", bundle: "core" });
        // Only the manifest is consulted; no tarball transfers.
        expect(requests.filter((p) => p.endsWith(".tar.zst"))).toEqual([]);
    }, 20_000);

    test("a checksum mismatch fails loud and leaves current untouched", async () => {
        await publishVersion("2026.07.04-aaa", ["core"]);
        expect((await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap().type).toBe("activated");

        await publishVersion("2026.07.05-bbb", ["core"], { tamperSha: "python" });
        const error = (await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrapErr();
        expect(error.type).toBe("checksum_mismatch");

        const active = (await readActive(storeRoot))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        // The failed pull's staging dir is reclaimed on every error path (not only sanity).
        expect(await stagingLeftovers(storeRoot)).toEqual([]);
    }, 20_000);

    // full is only resolvable on amd64 (arm64 downgrades it to core), so the
    // upgrade scenario is exercised where it can actually occur.
    test.if(arch === "linux-amd64")(
        "upgrading core→full at the same published version replaces the stale core tree",
        async () => {
            await publishVersion("2026.07.04-aaa", ["core", "full"]);
            expect((await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap().type).toBe("activated");
            expect(existsSync(join(storeRoot, "current", TRACK_SUBTREE.cran))).toBe(false);

            const outcome = (await libsPull("full", { quiet: true, yes: true }))._unsafeUnwrap();
            expect(outcome.type).toBe("activated");

            const active = (await readActive(storeRoot))._unsafeUnwrap();
            expect(active?.version).toBe("2026.07.04-aaa");
            expect(active?.meta?.bundle).toBe("full");
            expect(existsSync(join(storeRoot, "current", TRACK_SUBTREE.cran))).toBe(true);
            const expected = assembledPackages(FULL_TRACKS, "2026.07.04-aaa");
            expect(await Bun.file(join(storeRoot, "current", "packages.txt")).text()).toBe(expected);
        },
        20_000,
    );

    test("a pulled track missing its packages.txt fragment fails sanity, not silently", async () => {
        await publishVersion("2026.07.04-aaa", ["core"], { omitFragment: "node" });

        const error = (await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrapErr();
        expect(error.type).toBe("sanity_failed");

        expect((await readActive(storeRoot))._unsafeUnwrap()).toBeNull();
        expect(await stagingLeftovers(storeRoot)).toEqual([]);
    }, 20_000);

    test("the activated tree lands each track at its mount-plan subtree, un-nested, with the fragment at the root", async () => {
        await publishVersion("2026.07.04-aaa", ["core"]);
        expect((await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap().type).toBe("activated");

        const current = join(storeRoot, "current");
        // Subtree lands at exactly TRACK_SUBTREE[track] (what mount-plan.ts hard-codes),
        // NOT double-nested under itself — the finding-1 regression that hid packages.
        expect(existsSync(join(current, "python", "payload.bin"))).toBe(true);
        expect(existsSync(join(current, "python", "python"))).toBe(false);
        // The `<track>.packages.txt` fragment is carried into the final tree at the root.
        expect(existsSync(join(current, "python.packages.txt"))).toBe(true);
        expect(existsSync(join(current, "python", "packages.txt"))).toBe(false);
        // No pull debris promoted into the immutable tree: the `.pull.pid` liveness marker
        // (and any dotfile) is stripped before activation (finding 8) so the mounted store
        // stays byte-identical to a shell-assembled one.
        expect((await readdir(current)).filter((n) => n.startsWith("."))).toEqual([]);
    }, 20_000);

    test("payload downloads honor the mirror base via the manifest `path`, not the baked absolute url (finding 5)", async () => {
        // Absolute `url`s point at an unreachable host; only the relative `path` joined onto
        // the configured mirror base (libStoreUrl = baseUrl) can resolve the tarballs.
        await publishVersion("2026.07.04-aaa", ["core"], { deadUrls: true });

        const outcome = (await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap();
        expect(outcome.type).toBe("activated");
        expect((await readActive(storeRoot))._unsafeUnwrap()?.version).toBe("2026.07.04-aaa");
    }, 20_000);

    test("a concurrent pull holding the pull lock is refused with pull_in_progress, mutating nothing", async () => {
        await publishVersion("2026.07.04-aaa", ["core"]);

        // Stand in for another `inflexa` process mid-pull: seed the machine-wide lock
        // (lib/lock.ts) with a live FOREIGN pid. Pid 1 probes as EPERM, which the lock
        // treats as alive; our own pid would re-enter rather than contend.
        const lockPath = instanceLockPath("lib-store");
        await mkdir(env.locksDir, { recursive: true });
        await writeFile(lockPath, "1");
        try {
            const error = (await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrapErr();
            expect(error.type).toBe("pull_in_progress");
            // The store is untouched — no `current`, no staging debris, nothing on the wire.
            expect((await readActive(storeRoot))._unsafeUnwrap()).toBeNull();
            expect(await stagingLeftovers(storeRoot)).toEqual([]);
            expect(requests.filter((p) => p.endsWith(".tar.zst"))).toEqual([]);
        } finally {
            await rm(lockPath, { force: true });
        }

        // Once the holder releases, a pull proceeds normally.
        expect((await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap().type).toBe("activated");
    }, 20_000);
});

describe("countPackages", () => {
    test("counts comma-joined tokens per fragment line, not lines (matches validate.py)", () => {
        const text =
            PACKAGES_TXT_HEADER + "## Python (pip)\nnumpy,pandas,scipy\n\n## Node (npm)\nplotly.js,d3\n\n## System tools (CLI)\nsamtools,bcftools,bwa\n\n";
        // 3 (python) + 2 (node) + 3 (conda) = 8 — one comma-token line per section, header/`##` excluded.
        expect(countPackages(text)).toBe(8);
    });

    test("ignores blank lines and both `#` and `##` comment lines", () => {
        expect(countPackages(PACKAGES_TXT_HEADER)).toBe(0);
        expect(countPackages("## Section\n\n  \na, b ,c\n")).toBe(3);
    });
});

// Contract test: the CLI's assemblePackages must emit BYTE-IDENTICAL packages.txt to
// scripts/lib-store-assemble.sh for the same fragments. Rather than trust a mirrored
// fixture, drive the ACTUAL producer scripts (pack.sh + assemble.sh) and diff the CLI
// output against the shell output. Requires zstd (pack/assemble use it); skipped without.
const hasZstd = Bun.which("zstd") !== null;
describe("packages.txt byte-identity with the shell assembler (scripts/lib-store-*.sh)", () => {
    test.skipIf(!hasZstd)(
        "libsPull reproduces the exact bytes lib-store-assemble.sh writes for pack.sh tarballs",
        async () => {
            const scriptsDir = join(import.meta.dir, "..", "..", "..", "..", "scripts");
            const version = "2026.07.04-shell";
            const shellTracks: readonly Track[] = ["python", "conda", "node"];

            // Producer-shaped staging tree with REALISTIC fragments (## Section + comma-joined).
            const staging = await mkdtemp(join(tmpdir(), "libshellstage-"));
            const fragText: Record<string, string> = {
                python: "## Python (pip)\nnumpy,pandas,scipy\n",
                conda: "## System tools (CLI)\nsamtools,bcftools\n",
                node: "## Node (npm)\nplotly.js,d3\n",
            };
            for (const track of shellTracks) {
                await mkdir(join(staging, TRACK_SUBTREE[track]), { recursive: true });
                await writeFile(join(staging, TRACK_SUBTREE[track], "payload.bin"), `payload ${track}`);
                await writeFile(join(staging, `${track}.packages.txt`), fragText[track]!);
            }

            // pack.sh → per-track tarballs; assemble.sh → the reference packages.txt.
            const dist = await mkdtemp(join(tmpdir(), "libshelldist-"));
            expect(await Bun.spawn(["bash", join(scriptsDir, "lib-store-pack.sh"), staging, dist], { stdout: "ignore", stderr: "inherit" }).exited).toBe(0);
            const shellCurrent = join(await mkdtemp(join(tmpdir(), "libshellcur-")), "current");
            expect(
                await Bun.spawn(["bash", join(scriptsDir, "lib-store-assemble.sh"), "--tracks", shellTracks.join(" "), dist, shellCurrent], {
                    stdout: "ignore",
                    stderr: "inherit",
                }).exited,
            ).toBe(0);
            const shellPackages = await Bun.file(join(shellCurrent, "packages.txt")).text();

            // Publish those exact pack.sh tarballs and pull them through the CLI handler.
            const entries: Partial<Record<Track, TrackEntry>> = {};
            await mkdir(join(publishDir, version, arch), { recursive: true });
            for (const track of shellTracks) {
                const tarball = join(publishDir, version, arch, `${track}.tar.zst`);
                await Bun.write(tarball, Bun.file(join(dist, `${track}.tar.zst`)));
                entries[track] = {
                    url: `${baseUrl}/${version}/${arch}/${track}.tar.zst`,
                    sha256: (await sha256File(tarball))._unsafeUnwrap(),
                    size: Bun.file(tarball).size,
                };
            }
            const manifest = { version, tracks: Object.fromEntries(shellTracks.map((t) => [t, entries[t]])) };
            await mkdir(join(publishDir, "latest", MANIFEST_BUNDLE.core, arch), { recursive: true });
            await writeFile(join(publishDir, "latest", MANIFEST_BUNDLE.core, arch, "manifest.json"), JSON.stringify(manifest, null, 2));

            expect((await libsPull("core", { quiet: true, yes: true }))._unsafeUnwrap().type).toBe("activated");
            const pulled = await Bun.file(join(storeRoot, "current", "packages.txt")).text();
            expect(pulled).toBe(shellPackages);
            // Byte-identity extends to the WHOLE tree: no `.pull.pid` (or any dotfile) debris
            // that a shell-assembled store would never carry (finding 8).
            expect(existsSync(join(storeRoot, "current", ".pull.pid"))).toBe(false);
            expect((await readdir(join(storeRoot, "current"))).filter((n) => n.startsWith("."))).toEqual([]);

            await rm(staging, { recursive: true, force: true });
            await rm(dist, { recursive: true, force: true });
            await rm(shellCurrent, { recursive: true, force: true });
        },
        30_000,
    );
});
