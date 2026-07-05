import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256File } from "../../lib/hash.ts";
import { fetchManifest, manifestUrl, resolveBaseUrl } from "./manifest.ts";

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "libmanifest-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("sha256File", () => {
    test("streaming digest matches a one-shot hash of the same bytes", async () => {
        const bytes = new TextEncoder().encode("inflexa library store track bytes");
        const file = join(dir, "track.tar.zst");
        await writeFile(file, bytes);

        const expected = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const got = (await sha256File(file))._unsafeUnwrap();
        expect(got).toBe(expected);
    });

    test("a different file yields a different digest (mismatch is detectable)", async () => {
        await writeFile(join(dir, "a"), "one");
        await writeFile(join(dir, "b"), "two");
        const a = (await sha256File(join(dir, "a")))._unsafeUnwrap();
        const b = (await sha256File(join(dir, "b")))._unsafeUnwrap();
        expect(a).not.toBe(b);
    });
});

describe("manifestUrl", () => {
    test("builds the per-arch latest pointer path (no bundle segment)", () => {
        expect(manifestUrl("https://libs.example", "linux-amd64")).toBe("https://libs.example/latest/linux-amd64/manifest.json");
    });

    test("targets a pinned version when given", () => {
        expect(manifestUrl("https://libs.example", "linux-arm64", "2026.07.04-abc")).toBe("https://libs.example/2026.07.04-abc/linux-arm64/manifest.json");
    });
});

describe("resolveBaseUrl", () => {
    test("returns a base URL with no trailing slash", () => {
        expect(resolveBaseUrl().endsWith("/")).toBe(false);
    });
});

// SECURITY (finding 1): the manifest `version` flows into fs paths (versionDir /
// staging), so a hijacked store host serving a traversal must be rejected at the
// schema before it ever reaches the filesystem. Served from a real local server so
// this exercises the full fetch→validate path, not just the schema object.
describe("manifest version is validated as a safe path segment", () => {
    let server: ReturnType<typeof Bun.serve>;
    let base: string;
    let body: string;

    beforeEach(() => {
        server = Bun.serve({
            port: 0,
            fetch: () => new Response(body, { headers: { "content-type": "application/json" } }),
        });
        base = `http://localhost:${server.port}`;
    });
    afterEach(async () => {
        await server.stop(true);
    });

    const track = { url: "http://x/t.tar.zst", sha256: "a".repeat(64), size: 1 };

    test.each(["../../../home/user/x", "..", ".hidden", "a/b", "/abs", "with space"])("rejects unsafe version %p with manifest_failed", async (version) => {
        body = JSON.stringify({ version, tracks: { python: track } });
        const res = await fetchManifest(`${base}/manifest.json`);
        expect(res.isErr()).toBe(true);
        expect(res._unsafeUnwrapErr().type).toBe("manifest_failed");
    });

    test.each(["2026.07.04-abc", "local-20260704", "v1_2_3"])("accepts safe version %p", async (version) => {
        body = JSON.stringify({ version, tracks: { python: track } });
        const res = await fetchManifest(`${base}/manifest.json`);
        expect(res._unsafeUnwrap().version).toBe(version);
    });
});

// The shell writer and the TS reader cannot literally share a type — the writer runs in
// CI with no JS runtime — so this pins their contract by DRIVING the real producer
// (scripts/lib-store-write-manifest.sh) and reading its output back through fetchManifest.
// A drift in either half (a renamed field, a changed arch segment, a wrong digest source)
// breaks this test rather than surfacing as a mysterious pull failure in production.
describe("shell writer ↔ fetchManifest reader contract (scripts/lib-store-write-manifest.sh)", () => {
    let server: ReturnType<typeof Bun.serve>;
    let body: string;
    let base: string;

    beforeEach(() => {
        body = "";
        server = Bun.serve({
            port: 0,
            fetch: () => new Response(body, { headers: { "content-type": "application/json" } }),
        });
        base = `http://127.0.0.1:${server.port}`;
    });
    afterEach(async () => {
        await server.stop(true);
    });

    test("the arm64 manifest the writer emits round-trips path/sha256/size through fetchManifest", async () => {
        const scriptsDir = join(import.meta.dir, "..", "..", "..", "..", "scripts");
        const version = "20260705-abc";
        const armTracks = ["python", "conda", "node"] as const;

        // A fixture dist dir shaped like lib-store-pack.sh's output: one tarball per arm64
        // track plus a `<t>.tar.zst.sha256` sidecar holding the REAL digest of the bytes
        // (the writer reads the sidecar verbatim and stats the tarball for its size).
        const dist = await mkdtemp(join(tmpdir(), "libdist-"));
        const expected: Record<string, { sha256: string; size: number }> = {};
        for (const t of armTracks) {
            const tarball = join(dist, `${t}.tar.zst`);
            const bytes = new TextEncoder().encode(`fake ${t} tarball @ ${version}`);
            await writeFile(tarball, bytes);
            const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
            await writeFile(`${tarball}.sha256`, sha256);
            expected[t] = { sha256, size: bytes.byteLength };
        }

        // Drive the REAL producer; it prints the per-arch manifest JSON to stdout.
        // `env(1)` injects PUBLIC_URL on top of the inherited environment — the writer
        // requires it, and mutating/reading process.env is restricted in cli code.
        const proc = Bun.spawn(["env", `PUBLIC_URL=${base}`, "bash", join(scriptsDir, "lib-store-write-manifest.sh"), "arm64", version, dist], {
            stdout: "pipe",
            stderr: "inherit",
        });
        body = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);

        const manifest = (await fetchManifest(`${base}/manifest.json`))._unsafeUnwrap();
        expect(manifest.version).toBe(version);
        expect(Object.keys(manifest.tracks).sort()).toEqual([...armTracks].sort());
        for (const t of armTracks) {
            const entry = manifest.tracks[t]!;
            expect(entry.path).toBe(`${version}/linux-arm64/${t}.tar.zst`);
            expect(entry.sha256).toBe(expected[t]!.sha256);
            expect(entry.size).toBe(expected[t]!.size);
        }

        await rm(dist, { recursive: true, force: true });
    }, 15_000);
});
