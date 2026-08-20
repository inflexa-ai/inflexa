import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __setCompiledBinaryForTest } from "../../lib/install_context.ts";
import { installChannel, upgradeInstruction } from "./channel.ts";

const roots: string[] = [];
function root(): string {
    const path = mkdtempSync(join(tmpdir(), "inflexa-channel-"));
    roots.push(path);
    return path;
}

afterEach(() => {
    __setCompiledBinaryForTest(null);
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("installChannel", () => {
    test("a run that is not the compiled binary is a source run", () => {
        __setCompiledBinaryForTest(false);
        expect(installChannel("/opt/homebrew/Cellar/inflexa/0.16.1/bin/inflexa")).toBe("source");
    });

    test("a path under a node_modules @inflexa-ai scope is an npm install", () => {
        __setCompiledBinaryForTest(true);
        expect(installChannel("/home/x/.nvm/lib/node_modules/@inflexa-ai/inflexa-linux-x64/bin/inflexa")).toBe("npm");
    });

    test("the pnpm layout, which nests a second node_modules, is still an npm install", () => {
        __setCompiledBinaryForTest(true);
        const path = "/proj/node_modules/.pnpm/@inflexa-ai+inflexa-linux-x64@0.16.1/node_modules/@inflexa-ai/inflexa-linux-x64/bin/inflexa";
        expect(installChannel(path)).toBe("npm");
    });

    test("the postinstall fallback copy inside the wrapper package is an npm install", () => {
        __setCompiledBinaryForTest(true);
        expect(installChannel("/usr/lib/node_modules/@inflexa-ai/inflexa/bin-fallback/inflexa")).toBe("npm");
    });

    test("a path under a Cellar directory for inflexa is a Homebrew install", () => {
        __setCompiledBinaryForTest(true);
        expect(installChannel("/opt/homebrew/Cellar/inflexa/0.16.1/bin/inflexa")).toBe("homebrew");
    });

    test("a Cellar directory for a different formula is not read as this one", () => {
        __setCompiledBinaryForTest(true);
        expect(installChannel("/opt/homebrew/Cellar/ripgrep/14.1.0/bin/rg")).toBe("installer");
    });

    test("the Homebrew symbolic link on PATH resolves to its Cellar target", () => {
        __setCompiledBinaryForTest(true);
        // The whole reason installChannel resolves the path: `brew` puts a link in `<prefix>/bin`, and only
        // the target it points at carries the `Cellar` segment that names the channel.
        const prefix = root();
        const cellar = join(prefix, "Cellar", "inflexa", "0.16.1", "bin");
        mkdirSync(cellar, { recursive: true });
        mkdirSync(join(prefix, "bin"), { recursive: true });
        writeFileSync(join(cellar, "inflexa"), "");
        symlinkSync(join(cellar, "inflexa"), join(prefix, "bin", "inflexa"));

        expect(installChannel(join(prefix, "bin", "inflexa"))).toBe("homebrew");
    });

    test("anything else a compiled binary runs from came from the installer", () => {
        __setCompiledBinaryForTest(true);
        expect(installChannel("/home/x/.local/bin/inflexa")).toBe("installer");
    });

    test("a Windows installer path is read the same way, on either separator", () => {
        __setCompiledBinaryForTest(true);
        expect(installChannel("C:\\Users\\x\\AppData\\Local\\inflexa\\bin\\inflexa.exe")).toBe("installer");
        expect(installChannel("C:\\Users\\x\\node_modules\\@inflexa-ai\\inflexa-win32-x64\\bin\\inflexa.exe")).toBe("npm");
    });
});

describe("upgradeInstruction", () => {
    test("only the installer channel updates itself", () => {
        expect(upgradeInstruction("installer")).toBeNull();
    });

    test("a managed channel names the command of the tool that owns the file", () => {
        expect(upgradeInstruction("homebrew")).toBe("brew upgrade inflexa");
        expect(upgradeInstruction("npm")).toBe("npm install -g @inflexa-ai/inflexa@latest");
    });
});
