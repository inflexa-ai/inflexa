import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecretStore } from "../secret_store.ts";

let dir: string;
let filePath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-store-"));
    filePath = join(dir, "secrets.json");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const fileStore = () => createSecretStore({ service: "inflexa-test", filePath, platform: "linux" });

describe("createSecretStore — the file", () => {
    test("keeps a file that it cannot read beside the new file, and does not write over it", async () => {
        writeFileSync(filePath, '{"lims": "tok', { mode: 0o600 });
        await fileStore().write("github", "gh-1");

        expect(await fileStore().read("github")).toBe("gh-1");
        const kept = readdirSync(dir).filter((name) => name !== "secrets.json");
        expect(kept).toHaveLength(1);
        expect(readFileSync(join(dir, kept[0] ?? ""), "utf8")).toBe('{"lims": "tok');
    });

    test("writes the file with the mode 0600 when an old temporary file has a wider mode", async () => {
        writeFileSync(`${filePath}.tmp`, "{}", { mode: 0o644 });
        chmodSync(`${filePath}.tmp`, 0o644);
        await fileStore().write("github", "gh-1");

        expect(statSync(filePath).mode & 0o777).toBe(0o600);
    });
});
