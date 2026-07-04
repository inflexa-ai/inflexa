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
    test("builds the latest pointer path", () => {
        expect(manifestUrl("https://libs.example", "python-r-conda", "linux-amd64")).toBe(
            "https://libs.example/latest/python-r-conda/linux-amd64/manifest.json",
        );
    });

    test("targets a pinned version when given", () => {
        expect(manifestUrl("https://libs.example", "python-conda", "linux-arm64", "2026.07.04-abc")).toBe(
            "https://libs.example/2026.07.04-abc/python-conda/linux-arm64/manifest.json",
        );
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
