import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfig, writeConfig } from "../../../lib/config.ts";
import { runtimes } from "../../../lib/container.ts";
import { env } from "../../../lib/env.ts";
import { assertTestSandbox } from "../../../test_support/sandbox.ts";
import { sbomAction } from "../sbom.ts";

// `sbomAction` spawns `runtimes.docker.bin`. The test points that binary at a fake that answers `info` (ready) and
// `image inspect` (the image is there), and prints a chosen stderr for the read of the SBOM file, so the test reaches
// the `cat:` line scan of `readImageSbom` through the public entry.

const realBin = runtimes.docker.bin;
const realExitCode = process.exitCode;
let dir = "";
let errors: string[] = [];
let logged: Mock<typeof console.log>;
let failed: Mock<typeof console.error>;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sbom-"));
    const bin = join(dir, "docker");
    writeFileSync(
        bin,
        `#!/bin/sh
case "$1" in
  info) exit 0 ;;
  image) echo "sha256:fake"; exit 0 ;;
  run) cat '${join(dir, "stderr.txt")}' >&2; exit 1 ;;
esac
exit 1
`,
    );
    chmodSync(bin, 0o755);
    runtimes.docker.bin = bin;
    assertTestSandbox(env.configPath);
    writeConfig({ ...readConfig(), runtime: "docker" })._unsafeUnwrap();
    errors = [];
    logged = spyOn(console, "log").mockImplementation(() => undefined);
    failed = spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
    });
});

afterEach(() => {
    runtimes.docker.bin = realBin;
    assertTestSandbox(env.configPath);
    rmSync(env.configPath, { force: true });
    process.exitCode = realExitCode ?? 0;
    rmSync(dir, { recursive: true, force: true });
    logged.mockRestore();
    failed.mockRestore();
});

/** The reasons that the command printed for the two images, given the stderr of the failed read. */
async function reasonsFor(stderr: string): Promise<string[]> {
    writeFileSync(join(dir, "stderr.txt"), stderr);
    await sbomAction();
    return errors.filter(
        (line) => line.startsWith("inflexa sbom: no SBOM for ") && !line.includes("package store") && !line.startsWith("inflexa sbom: no SBOM for inflexa "),
    );
}

const ABSENT = "a build before the SBOM";
const FAILED = "could not read";

describe("sbomAction — the cat line of a failed read", () => {
    test("a cat line that names a missing file marks an image from before the SBOM", async () => {
        const reasons = await reasonsFor("cat: /usr/share/sbom.cdx.json: No such file or directory\n");
        expect(reasons).toHaveLength(2);
        for (const reason of reasons) expect(reason).toContain(ABSENT);
    });

    test("the match is case-insensitive in both phrases, and the file name may be empty", async () => {
        for (const stderr of ["CAT: X NO SUCH FILE", "cat: no such file", "Cat: /x: No Such File"]) {
            const reasons = await reasonsFor(stderr);
            expect(reasons.every((reason) => reason.includes(ABSENT))).toBe(true);
            expect(reasons).toHaveLength(2);
            errors = [];
        }
    });

    test("each line terminator starts a new line, as the pattern with the m flag did", async () => {
        for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
            const reasons = await reasonsFor(`warning: slow${terminator}cat: /x: no such file or directory`);
            expect(reasons.every((reason) => reason.includes(ABSENT))).toBe(true);
            expect(reasons).toHaveLength(2);
            errors = [];
        }
    });

    test("the phrase must sit on the line of the cat prefix: no terminator is crossed", async () => {
        for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
            const reasons = await reasonsFor(`cat: /x: failed${terminator}no such file`);
            expect(reasons.every((reason) => reason.includes(FAILED))).toBe(true);
            expect(reasons).toHaveLength(2);
            errors = [];
        }
    });

    test("a cat prefix that is not at the start of a line does not count", async () => {
        const reasons = await reasonsFor("error: cat: /x: no such file");
        expect(reasons).toHaveLength(2);
        expect(reasons.every((reason) => reason.includes(FAILED))).toBe(true);
    });

    test("another failure of the read keeps its first line as the reason", async () => {
        const reasons = await reasonsFor("permission denied\nsecond line\n");
        expect(reasons).toHaveLength(2);
        expect(reasons.every((reason) => reason.endsWith("permission denied"))).toBe(true);
    });
});
