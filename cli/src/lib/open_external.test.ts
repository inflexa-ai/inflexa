import { describe, expect, test } from "bun:test";

import { isWslVersion, openerArgv, openExternal, type OpenSeams } from "./open_external.ts";

/** An ENOENT-shaped spawn error, as `Bun.spawn` throws when the opener binary is missing. */
function enoent(): Error {
    const e = new Error("spawn wslview ENOENT");
    (e as Error & { code: string }).code = "ENOENT";
    return e;
}

describe("openerArgv", () => {
    test("uses `open` on macOS", () => {
        expect(openerArgv("/d", "darwin", false)).toEqual(["open", "/d"]);
    });

    test("uses `cmd /c start` with the empty title arg on Windows", () => {
        // The "" is the START title argument — without it a quoted path is taken as the window title.
        expect(openerArgv("/d", "win32", false)).toEqual(["cmd", "/c", "start", "", "/d"]);
    });

    test("uses `xdg-open` on plain Linux", () => {
        expect(openerArgv("/d", "linux", false)).toEqual(["xdg-open", "/d"]);
    });

    test("prefers `wslview` under WSL (xdg-open is absent/wrong there)", () => {
        expect(openerArgv("/d", "linux", true)).toEqual(["wslview", "/d"]);
    });
});

describe("isWslVersion", () => {
    test("detects a Microsoft kernel string", () => {
        expect(isWslVersion("Linux version 5.15.0-microsoft-standard-WSL2")).toBe(true);
    });
    test("plain Linux is not WSL", () => {
        expect(isWslVersion("Linux version 6.1.0-generic")).toBe(false);
    });
});

describe("openExternal", () => {
    test("spawns the platform argv and returns ok", () => {
        const cmds: string[][] = [];
        const seams: OpenSeams = { spawn: (cmd) => cmds.push(cmd), toWindowsPath: () => null, platform: "linux", wsl: false };
        expect(openExternal("/x", seams).isOk()).toBe(true);
        expect(cmds).toEqual([["xdg-open", "/x"]]);
    });

    test("degrades to err (never throws) when the opener binary is missing (ENOENT)", () => {
        const seams: OpenSeams = {
            spawn: () => {
                throw enoent();
            },
            toWindowsPath: () => null,
            platform: "linux",
            wsl: false,
        };
        openExternal("/x", seams).match(
            () => {
                throw new Error("expected an ENOENT error, got ok");
            },
            (e) => expect(e.code).toBe("ENOENT"),
        );
    });

    test("under WSL a missing wslview falls back to explorer.exe with a wslpath-translated path", () => {
        const cmds: string[][] = [];
        let call = 0;
        const seams: OpenSeams = {
            spawn: (cmd) => {
                cmds.push(cmd);
                if (call++ === 0) throw enoent(); // wslview missing
            },
            toWindowsPath: () => "C:\\Users\\me\\x",
            platform: "linux",
            wsl: true,
        };
        const result = openExternal("/mnt/c/Users/me/x", seams);
        expect(result.isOk()).toBe(true);
        expect(cmds[0]).toEqual(["wslview", "/mnt/c/Users/me/x"]);
        expect(cmds[1]).toEqual(["explorer.exe", "C:\\Users\\me\\x"]);
    });

    test("under WSL with an untranslatable path the original failure is returned", () => {
        const seams: OpenSeams = {
            spawn: () => {
                throw enoent();
            },
            toWindowsPath: () => null, // wslpath failed
            platform: "linux",
            wsl: true,
        };
        expect(openExternal("/x", seams).isErr()).toBe(true);
    });
});
