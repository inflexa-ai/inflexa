import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "neverthrow";

import { __setCompiledBinaryForTest } from "../../lib/install_context.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import {
    __resetLlamaRuntimeForTest,
    __setLlamaAcquireForTest,
    __setLlamaPinForTest,
    ensureLlamaServer,
    materializedLlamaServer,
    type ResolvedPin,
} from "./llama_runtime.ts";

// Drives the materialization pipeline through its public surface against the sandboxed
// env.llamaServerDir, using the module's test seams (forced pin + stubbed acquisition) so no test
// ever touches the real network or a real embedded asset. The fixture is a genuine tar.gz built with
// system `tar`, so extraction, the single-top-dir descend, and the atomic rename run for real.

const TEST_TAG = "test-tag";

// A valid nested fixture archive (`runtime/llama-server`, matching the real macOS/Linux layout), plus
// its true SHA-256 so an injected pin can pass verification. Built once — the bytes are immutable.
async function buildFixtureArchive(): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
    const work = mkdtempSync(join(tmpdir(), "inflexa-llama-fixture-"));
    await mkdir(join(work, "runtime"), { recursive: true });
    await Bun.write(join(work, "runtime", "llama-server"), "#!/bin/sh\necho inflexa-fixture-llama-server\n");
    const tarPath = join(work, "fixture.tar.gz");
    const proc = Bun.spawn(["tar", "czf", tarPath, "-C", work, "runtime"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    const bytes = await Bun.file(tarPath).bytes();
    rmSync(work, { recursive: true, force: true });
    return { bytes, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

const fixture = await buildFixtureArchive();

function pinWith(sha256: string): ResolvedPin {
    return { tag: TEST_TAG, target: "darwin-arm64", artifact: "fixture.tar.gz", sha256 };
}

/** An acquire stub that writes `bytes` to the staging path and records how many times / from which source. */
function stubAcquire(bytes: Uint8Array): { calls: number; sources: string[] } {
    const spy = { calls: 0, sources: [] as string[] };
    __setLlamaAcquireForTest(async (source, destPath) => {
        spy.calls += 1;
        spy.sources.push(source);
        await Bun.write(destPath, bytes);
        return ok(undefined);
    });
    return spy;
}

const finalDir = join(env.llamaServerDir, TEST_TAG);

beforeEach(() => {
    assertTestSandbox(env.llamaServerDir);
});

afterEach(() => {
    __resetLlamaRuntimeForTest();
    __setCompiledBinaryForTest(null);
    assertTestSandbox(env.llamaServerDir);
    // Wipe the whole runtime dir (the tag dir plus any leftover .tmp-* staging) between tests.
    rmSync(env.llamaServerDir, { recursive: true, force: true });
});

describe("ensureLlamaServer — materialization", () => {
    test("materializes a verified archive and returns the server binary path", async () => {
        __setLlamaPinForTest(pinWith(fixture.sha256));
        stubAcquire(fixture.bytes);

        const result = await ensureLlamaServer();
        const path = result.match(
            (p) => p,
            () => null,
        );
        expect(path).toBe(join(finalDir, "llama-server"));
        expect(existsSync(join(finalDir, "llama-server"))).toBe(true);
        // Nothing left staging behind on success.
        expect(existsSync(join(finalDir, "runtime"))).toBe(false);
    });

    test("hash mismatch is fatal and leaves nothing at the final path", async () => {
        // Pin claims a hash the fixture does not have, so verification must reject it.
        __setLlamaPinForTest(pinWith("0".repeat(64)));
        stubAcquire(fixture.bytes);

        const result = await ensureLlamaServer();
        const errType = result.match(
            () => null,
            (e) => e.type,
        );
        expect(errType).toBe("hash_mismatch");
        expect(existsSync(finalDir)).toBe(false);
    });

    test("a partial/corrupt extraction leaves nothing at the final path", async () => {
        // Bytes that pass the hash gate but are NOT a valid archive → tar fails → extract_failed.
        const notAnArchive = new TextEncoder().encode("this is not a tar or zip archive");
        const sha256 = new Bun.CryptoHasher("sha256").update(notAnArchive).digest("hex");
        __setLlamaPinForTest(pinWith(sha256));
        stubAcquire(notAnArchive);

        const result = await ensureLlamaServer();
        const errType = result.match(
            () => null,
            (e) => e.type,
        );
        expect(errType).toBe("extract_failed");
        expect(existsSync(finalDir)).toBe(false);
    });

    test("re-running after success does no acquisition work (idempotent)", async () => {
        __setLlamaPinForTest(pinWith(fixture.sha256));
        const spy = stubAcquire(fixture.bytes);

        const first = await ensureLlamaServer();
        expect(first.isOk()).toBe(true);
        expect(spy.calls).toBe(1);

        // Second call sees the materialized tag dir and short-circuits — no acquire, no extraction.
        const second = await ensureLlamaServer();
        const path = second.match(
            (p) => p,
            () => null,
        );
        expect(path).toBe(join(finalDir, "llama-server"));
        expect(spy.calls).toBe(1);
    });
});

describe("ensureLlamaServer — source selection", () => {
    test("compiled context acquires from the embedded asset path", async () => {
        __setCompiledBinaryForTest(true);
        __setLlamaPinForTest(pinWith(fixture.sha256));
        const spy = stubAcquire(fixture.bytes);

        const result = await ensureLlamaServer();
        expect(result.isOk()).toBe(true);
        expect(spy.sources).toEqual(["embedded"]);
    });

    test("from-source context acquires via download", async () => {
        __setCompiledBinaryForTest(false);
        __setLlamaPinForTest(pinWith(fixture.sha256));
        const spy = stubAcquire(fixture.bytes);

        const result = await ensureLlamaServer();
        expect(result.isOk()).toBe(true);
        expect(spy.sources).toEqual(["download"]);
    });
});

describe("materializedLlamaServer", () => {
    test("is null before materialization and the binary path after", async () => {
        __setLlamaPinForTest(pinWith(fixture.sha256));
        stubAcquire(fixture.bytes);

        expect(materializedLlamaServer()).toBeNull();
        (await ensureLlamaServer()).match(
            () => undefined,
            () => undefined,
        );
        expect(materializedLlamaServer()).toBe(join(finalDir, "llama-server"));
    });
});
