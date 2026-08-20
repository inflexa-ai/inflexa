import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyErrorMessage, applyUpdate, releaseAsset } from "./apply.ts";

const roots: string[] = [];
function root(): string {
    const path = mkdtempSync(join(tmpdir(), "inflexa-apply-"));
    roots.push(path);
    return path;
}

afterEach(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const NEW_BINARY = "the new inflexa";

function sha(body: string): string {
    return createHash("sha256").update(body).digest("hex");
}

/**
 * An offline release: serves `SHA256SUMS` and the asset. `sums` overrides what the manifest claims, which
 * is how the checksum-mismatch path is exercised without a corrupt body.
 */
function serveRelease(asset: string, body: string, sums?: string): FetchStub {
    return async (input) => {
        const url = String(input);
        if (url.endsWith("/SHA256SUMS")) return new Response(sums ?? `${sha(body)}  ${asset}\n`);
        return new Response(body);
    };
}

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe("releaseAsset", () => {
    test("names the published asset for each platform this project ships", () => {
        expect(releaseAsset("linux-x64")).toBe("inflexa-linux-x64");
        expect(releaseAsset("darwin-arm64")).toBe("inflexa-darwin-arm64");
        // The release says `windows` where node says `win32`, which is why the table is explicit.
        expect(releaseAsset("win32-x64")).toBe("inflexa-windows-x64.exe");
    });

    test("a platform with no published binary has no asset", () => {
        expect(releaseAsset("linux-arm")).toBeNull();
    });
});

describe("applyUpdate", () => {
    test("puts the verified download in place of the target binary", async () => {
        const target = join(root(), "inflexa");
        writeFileSync(target, "the old inflexa");

        const result = await applyUpdate("0.17.0", {
            targetPath: target,
            platformKey: "linux-x64",
            fetch: serveRelease("inflexa-linux-x64", NEW_BINARY),
        });

        expect(result.isOk()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe(NEW_BINARY);
    });

    test("leaves no staged file behind on the way through", async () => {
        const dir = root();
        const target = join(dir, "inflexa");
        writeFileSync(target, "the old inflexa");

        await applyUpdate("0.17.0", { targetPath: target, platformKey: "linux-x64", fetch: serveRelease("inflexa-linux-x64", NEW_BINARY) });

        expect(readdirSync(dir)).toEqual(["inflexa"]);
    });

    test("refuses a body that does not match the released checksum, and keeps the old binary", async () => {
        const dir = root();
        const target = join(dir, "inflexa");
        writeFileSync(target, "the old inflexa");

        const result = await applyUpdate("0.17.0", {
            targetPath: target,
            platformKey: "linux-x64",
            // https covers the transport; the digest covers that this is what the release workflow attested.
            fetch: serveRelease("inflexa-linux-x64", NEW_BINARY, `${sha("something else")}  inflexa-linux-x64\n`),
        });

        expect(result._unsafeUnwrapErr().type).toBe("checksum_mismatch");
        expect(readFileSync(target, "utf8")).toBe("the old inflexa");
        expect(readdirSync(dir)).toEqual(["inflexa"]);
    });

    test("refuses a platform with no published binary before it reaches the network", async () => {
        const result = await applyUpdate("0.17.0", {
            targetPath: join(root(), "inflexa"),
            platformKey: "linux-arm",
            fetch: () => {
                throw new Error("the network must not be read");
            },
        });
        expect(result._unsafeUnwrapErr()).toEqual({ type: "unsupported_platform", platform: "linux-arm" });
    });

    test("reports a release whose manifest does not list this platform's asset", async () => {
        const target = join(root(), "inflexa");
        writeFileSync(target, "the old inflexa");

        const result = await applyUpdate("0.17.0", {
            targetPath: target,
            platformKey: "linux-x64",
            fetch: serveRelease("inflexa-linux-x64", NEW_BINARY, `${sha(NEW_BINARY)}  inflexa-darwin-arm64\n`),
        });

        expect(result._unsafeUnwrapErr()).toEqual({ type: "asset_missing", asset: "inflexa-linux-x64" });
    });

    test("reports a manifest the release does not serve", async () => {
        const target = join(root(), "inflexa");
        writeFileSync(target, "the old inflexa");

        const result = await applyUpdate("0.17.0", {
            targetPath: target,
            platformKey: "linux-x64",
            fetch: async () => new Response("", { status: 404 }),
        });

        expect(result._unsafeUnwrapErr()).toEqual({ type: "manifest_failed", status: 404 });
    });

    test("sweeps the file a previous Windows update left beside the target", async () => {
        const dir = root();
        const target = join(dir, "inflexa");
        writeFileSync(target, "the old inflexa");
        // Windows cannot delete the binary it is running, so the update that moved it aside could not
        // reclaim it either. The next update is the first moment that file is removable.
        writeFileSync(`${target}.old`, "an older inflexa");

        await applyUpdate("0.17.0", { targetPath: target, platformKey: "linux-x64", fetch: serveRelease("inflexa-linux-x64", NEW_BINARY) });

        expect(existsSync(`${target}.old`)).toBe(false);
    });
});

describe("applyErrorMessage", () => {
    test("a failed write names the action that fixes it", () => {
        const message = applyErrorMessage({ type: "swap_failed", path: "/usr/local/bin/inflexa", cause: new Error("EACCES") });
        expect(message).toContain("/usr/local/bin/inflexa");
        expect(message).toContain("installer");
    });

    test("a checksum mismatch reports both digests", () => {
        const message = applyErrorMessage({ type: "checksum_mismatch", expected: "aaa", actual: "bbb" });
        expect(message).toContain("aaa");
        expect(message).toContain("bbb");
    });
});
