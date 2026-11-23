import { describe, expect, test } from "bun:test";

import { isWslVersion, noDisplayReason, openerArgv, openExternal, sshForwardCommand, type OpenSeams } from "../open_external.ts";

/** An ENOENT-shaped spawn error, as `Bun.spawn` throws when the opener binary is missing. */
function enoent(): Error {
    return Object.assign(new Error("spawn wslview ENOENT"), { code: "ENOENT" });
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
        const seams: OpenSeams = {
            spawn: (cmd) => cmds.push(cmd),
            toWindowsPath: () => null,
            platform: "linux",
            wsl: false,
            sshConnection: null,
            display: true,
        };
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
            sshConnection: null,
            display: true,
            wsl: false,
        };
        openExternal("/x", seams).match(
            () => {
                throw new Error("expected an ENOENT error, got ok");
            },
            (e) => expect(e).toMatchObject({ type: "open_failed", code: "ENOENT" }),
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
            sshConnection: null,
            display: true,
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
            sshConnection: null,
            display: true,
            wsl: true,
        };
        expect(openExternal("/x", seams).isErr()).toBe(true);
    });
});

describe("a session with no display", () => {
    function seams(facts: Pick<OpenSeams, "sshConnection" | "display" | "platform" | "wsl">, cmds: string[][]): OpenSeams {
        return { ...facts, spawn: (cmd) => cmds.push(cmd), toWindowsPath: () => null };
    }

    test("over SSH, no opener runs, because xdg-open can exit 0 with no browser on the screen of the person", () => {
        const cmds: string[][] = [];
        const result = openExternal(
            "http://127.0.0.1:8431/gui/",
            seams({ sshConnection: "10.0.0.5 51000 10.0.0.9 22", display: true, platform: "linux", wsl: false }, cmds),
        );
        expect(result._unsafeUnwrapErr()).toEqual({ type: "no_display", reason: "ssh" });
        expect(cmds).toEqual([]);
    });

    test("Linux with no X11 and no Wayland display runs no opener", () => {
        const cmds: string[][] = [];
        const result = openExternal("/x", seams({ sshConnection: null, display: false, platform: "linux", wsl: false }, cmds));
        expect(result._unsafeUnwrapErr()).toEqual({ type: "no_display", reason: "headless" });
        expect(cmds).toEqual([]);
    });

    test("WSL and macOS need no Linux display", () => {
        expect(noDisplayReason({ sshConnection: null, display: false, platform: "linux", wsl: true })).toBeNull();
        expect(noDisplayReason({ sshConnection: null, display: false, platform: "darwin", wsl: false })).toBeNull();
    });

    test("the forward command names the port and the address that the person connected to", () => {
        expect(sshForwardCommand(8431, "10.0.0.5 51000 10.0.0.9 22")).toEndWith("@10.0.0.9");
        expect(sshForwardCommand(8431, "10.0.0.5 51000 10.0.0.9 22")).toStartWith("ssh -N -L 8431:127.0.0.1:8431 ");
    });
});
