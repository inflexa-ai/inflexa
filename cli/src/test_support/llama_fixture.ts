import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ResolvedPin } from "../modules/embedding/llama_runtime.ts";

/** A genuine tar.gz runtime archive and the SHA-256 that verifies it. */
export type LlamaFixtureArchive = {
    readonly bytes: Uint8Array;
    readonly sha256: string;
};

/**
 * Build a valid nested runtime archive (`runtime/llama-server`, the real macOS/Linux layout) with
 * system `tar`, plus its true SHA-256 so an injected pin can pass verification. The bytes are
 * immutable, so a file builds the fixture once; extraction, the single-top-dir descend, and the
 * atomic rename then run for real in every test that uses it — no test touches the network or a real
 * embedded asset.
 */
export async function llamaFixtureArchive(dirPrefix: string, entryScript: string): Promise<LlamaFixtureArchive> {
    const work = mkdtempSync(join(tmpdir(), dirPrefix));
    mkdirSync(join(work, "runtime"), { recursive: true });
    await Bun.write(join(work, "runtime", "llama-server"), entryScript);
    const tarPath = join(work, "fixture.tar.gz");
    const proc = Bun.spawn(["tar", "czf", tarPath, "-C", work, "runtime"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    const bytes = await Bun.file(tarPath).bytes();
    rmSync(work, { recursive: true, force: true });
    return { bytes, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

/** The pin a test injects so the runtime accepts {@link llamaFixtureArchive}'s bytes. */
export function llamaFixturePin(tag: string, sha256: string): ResolvedPin {
    return { tag, target: "darwin-arm64", artifact: "fixture.tar.gz", sha256 };
}
