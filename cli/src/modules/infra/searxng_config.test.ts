import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeSearxngSettings } from "./searxng_config.ts";
import { formatInfraStateError, publishFileExclusively, tryFs } from "./mount_source.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

// writeSearxngSettings writes the REAL file at env.searxngSettingsPath. Under the test preload that
// lives inside the mkdtemp sandbox; guard first (the data-loss backstop) and reap the settings dir
// between tests so each starts from a clean slate.
describe("writeSearxngSettings", () => {
    const settingsPath = env.searxngSettingsPath;
    const settingsDir = dirname(settingsPath);

    function reset(): void {
        assertTestSandbox(settingsDir);
        rmSync(settingsDir, { recursive: true, force: true });
    }
    beforeEach(reset);
    afterEach(reset);

    test("the first write makes the canonical settings with a random 32-byte hex key", async () => {
        (await writeSearxngSettings())._unsafeUnwrap();

        const text = readFileSync(settingsPath, "utf8");
        expect(text).toContain("use_default_settings: true\n");
        expect(text).toMatch(/server:\n {2}secret_key: "[0-9a-f]{64}"\n {2}limiter: false\n {2}public_instance: false\n/);
        expect(text).toContain("search:\n  formats:\n    - html\n    - json\n");
        // The shipped key stops the container; the provisioned key must never be it.
        expect(text).not.toContain("ultrasecretkey");
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
        expect(statSync(settingsDir).mode & 0o777).toBe(0o700);
    });

    test("the first write lands through the temp file and leaves no temp file behind", async () => {
        (await writeSearxngSettings())._unsafeUnwrap();

        expect(readdirSync(settingsDir)).toEqual(["settings.yml"]);
    });

    test("a second run keeps the file byte-identical — the key is made one time", async () => {
        (await writeSearxngSettings())._unsafeUnwrap();
        const before = readFileSync(settingsPath, "utf8");

        (await writeSearxngSettings())._unsafeUnwrap();

        expect(readFileSync(settingsPath, "utf8")).toBe(before);
    });

    test("two independent first writes mint different keys", async () => {
        (await writeSearxngSettings())._unsafeUnwrap();
        const first = readFileSync(settingsPath, "utf8");
        rmSync(settingsDir, { recursive: true, force: true });

        (await writeSearxngSettings())._unsafeUnwrap();

        expect(readFileSync(settingsPath, "utf8")).not.toBe(first);
    });

    test("a publish that lost the race keeps the winner's key byte-identical", async () => {
        (await writeSearxngSettings())._unsafeUnwrap();
        const winner = readFileSync(settingsPath, "utf8");

        // The lost race, made deterministic: the path was classified absent, then another call
        // published its settings before this call's publish step ran. `link` must refuse the target,
        // the loser must report ok, and the winner's file must stay untouched with no temp left.
        const lost = await publishFileExclusively(settingsPath, (tmp) => tryFs(tmp, () => writeFile(tmp, "loser: settings\n", { mode: 0o600 })));

        expect(lost._unsafeUnwrap()).toBeUndefined();
        expect(readFileSync(settingsPath, "utf8")).toBe(winner);
        expect(readdirSync(settingsDir)).toEqual(["settings.yml"]);
    });

    test("an existing regular file the user may have edited stays untouched", async () => {
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(settingsPath, "use_default_settings: true\n", { mode: 0o600 });

        (await writeSearxngSettings())._unsafeUnwrap();

        expect(readFileSync(settingsPath, "utf8")).toBe("use_default_settings: true\n");
    });

    test("an EMPTY directory manufactured at the settings path is healed: rmdir'd, then the file is written", async () => {
        mkdirSync(settingsPath, { recursive: true });
        expect(statSync(settingsPath).isDirectory()).toBe(true);

        (await writeSearxngSettings())._unsafeUnwrap();

        expect(statSync(settingsPath).isFile()).toBe(true);
    });

    test("a NON-EMPTY directory at the settings path is preserved untouched with a path_occupied error", async () => {
        mkdirSync(settingsPath, { recursive: true });
        writeFileSync(join(settingsPath, "keep.txt"), "precious");

        const error = (await writeSearxngSettings())._unsafeUnwrapErr();

        expect(error.type).toBe("path_occupied");
        if (error.type === "path_occupied") expect(error.path).toBe(settingsPath);
        expect(statSync(settingsPath).isDirectory()).toBe(true);
        expect(readFileSync(join(settingsPath, "keep.txt"), "utf8")).toBe("precious");
    });

    test("a SYMLINK at the settings path is refused untouched, never followed, and classified as a symlink", async () => {
        // Point the link at a real file so "followed" would be observable — following it would clobber the
        // target's bytes. The provisioner must lstat, classify it occupied without following, and delete
        // neither the link nor its target.
        mkdirSync(settingsDir, { recursive: true });
        const target = join(settingsDir, "elsewhere.txt");
        writeFileSync(target, "target-bytes");
        symlinkSync(target, settingsPath);

        const error = (await writeSearxngSettings())._unsafeUnwrapErr();

        expect(error.type).toBe("path_occupied");
        if (error.type === "path_occupied") expect(error.occupant).toBe("symlink");
        expect(readFileSync(target, "utf8")).toBe("target-bytes");
        const msg = formatInfraStateError(error);
        expect(msg).toContain(settingsPath);
        expect(msg).toMatch(/symlink/i);
        expect(msg).not.toMatch(/not empty/i);
    });
});
