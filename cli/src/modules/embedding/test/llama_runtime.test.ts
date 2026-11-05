import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ok } from "neverthrow";

import { __setCompiledBinaryForTest } from "../../../lib/install_context.ts";
import { env } from "../../../lib/env.ts";
import { assertTestSandbox } from "../../../test_support/sandbox.ts";
import { llamaFixtureArchive, llamaFixturePin } from "../../../test_support/llama_fixture.ts";
import { __resetLlamaRuntimeForTest, __setLlamaAcquireForTest, __setLlamaPinForTest, ensureLlamaServer, materializedLlamaServer } from "../llama_runtime.ts";

// Drives the materialization pipeline through its public surface against the sandboxed
// env.llamaServerDir, using the module's test seams (forced pin + stubbed acquisition) so no test
// ever touches the real network or a real embedded asset. The fixture is a genuine tar.gz built with
// system `tar`, so extraction, the single-top-dir descend, and the atomic rename run for real.

const TEST_TAG = "test-tag";

// A valid nested fixture archive (`runtime/llama-server`, matching the real macOS/Linux layout), plus
// its true SHA-256 so an injected pin can pass verification. Built once — the bytes are immutable.
const fixture = await llamaFixtureArchive("inflexa-llama-fixture-", "#!/bin/sh\necho inflexa-fixture-llama-server\n");

/** An acquire stub that writes `bytes` to the staging path and records how many times / from which source. */
function stubAcquire(bytes: Uint8Array): { calls: number; sources: string[] } {
    const spy: { calls: number; sources: string[] } = { calls: 0, sources: [] };
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
        __setLlamaPinForTest(llamaFixturePin(TEST_TAG, fixture.sha256));
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
        __setLlamaPinForTest(llamaFixturePin(TEST_TAG, "0".repeat(64)));
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
        __setLlamaPinForTest(llamaFixturePin(TEST_TAG, sha256));
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
        __setLlamaPinForTest(llamaFixturePin(TEST_TAG, fixture.sha256));
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
        __setLlamaPinForTest(llamaFixturePin(TEST_TAG, fixture.sha256));
        const spy = stubAcquire(fixture.bytes);

        const result = await ensureLlamaServer();
        expect(result.isOk()).toBe(true);
        expect(spy.sources).toEqual(["embedded"]);
    });

    test("from-source context acquires via download", async () => {
        __setCompiledBinaryForTest(false);
        __setLlamaPinForTest(llamaFixturePin(TEST_TAG, fixture.sha256));
        const spy = stubAcquire(fixture.bytes);

        const result = await ensureLlamaServer();
        expect(result.isOk()).toBe(true);
        expect(spy.sources).toEqual(["download"]);
    });
});

describe("materializedLlamaServer", () => {
    test("is null before materialization and the binary path after", async () => {
        __setLlamaPinForTest(llamaFixturePin(TEST_TAG, fixture.sha256));
        stubAcquire(fixture.bytes);

        expect(materializedLlamaServer()).toBeNull();
        (await ensureLlamaServer()).match(
            () => undefined,
            () => undefined,
        );
        expect(materializedLlamaServer()).toBe(join(finalDir, "llama-server"));
    });
});
