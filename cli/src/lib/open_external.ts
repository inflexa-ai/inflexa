import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { err, ok, type Result } from "neverthrow";

import { browserMode, type BrowserMode } from "./config.ts";
import { terminalEnv } from "./env.ts";
import { errnoCode } from "./fs.ts";

// The single shared "open this in the default OS application" helper: every caller (auth login, analysis
// open, artifact open) routes through it, so per-platform opener selection — including the WSL case — lives
// in one place. A failed open never throws and never blocks a turn: it returns `Result` with the failure on
// the error channel, and every caller degrades to a notice carrying the path (the artifact-open spec's rule).

/**
 * Why an external open could not be spawned. `code` carries the OS error code when known (`ENOENT` for a
 * missing opener binary — a headless box without `xdg-open`) so a caller can distinguish "no opener" from
 * a transient spawn fault, though every caller degrades the same way: a notice with the path.
 */
export type OpenExternalError =
    | { type: "open_failed"; code: string | null; cause: unknown }
    /** No opener ran: no browser or file manager can show on this machine (see {@link noDisplayReason}), or the browser setting is `never`. */
    | { type: "no_display"; reason: NoDisplayReason | "disabled" };

/** Why this session has no display: it runs through SSH, or it is Linux with no X11 and no Wayland display. */
export type NoDisplayReason = "ssh" | "headless";

/** How a person sets the browser setting, for a message. */
const BROWSER_SETTING = '`INFLEXA_BROWSER=never`, or `"browser": "never"` in config.json';

/** The facts of the session that decide if an opener can show a window. Tests give their own. */
export type DisplayFacts = {
    readonly sshConnection: string | null;
    readonly display: boolean;
    readonly platform: NodeJS.Platform;
    readonly wsl: boolean;
};

/**
 * Why an opener cannot show a window in this session, or `null` when it can. Over SSH, `xdg-open` can start and
 * exit 0 with no browser on the screen of the person, thus a success of the spawn proves nothing. WSL opens
 * through Windows, and it needs no Linux display.
 */
export function noDisplayReason(facts: DisplayFacts): NoDisplayReason | null {
    if (facts.sshConnection !== null) return "ssh";
    if (facts.platform === "linux" && !facts.wsl && !facts.display) return "headless";
    return null;
}

/**
 * The `ssh -L` command that forwards `port` of this machine to the same port of the machine of the person. The
 * user and the host come from this session: `SSH_CONNECTION` names the address that the person connected to.
 */
export function sshForwardCommand(port: number, sshConnection: string | null = terminalEnv.sshConnection): string {
    const host = sshConnection?.split(" ")[2] ?? "<this-host>";
    return `ssh -N -L ${port}:127.0.0.1:${port} ${userInfo().username}@${host}`;
}

/**
 * The primary OS argv that opens `target` (a file, directory, or URL) in the default application.
 * `platform`/`wsl` are parameters (defaulting to the running host) purely so the selection is
 * unit-testable without mutating the global `process.platform` or the `/proc/version` probe:
 *
 *   - darwin → `open`
 *   - win32  → `cmd /c start "" <target>` (the empty `""` is START's title arg — without it a quoted
 *              path is taken as the window title, not the thing to open)
 *   - WSL    → `wslview` (xdg-open is typically absent or wrong under WSL); {@link openExternal} falls
 *              back to `explorer.exe` with a `wslpath -w` translated path when `wslview` is missing
 *   - linux  → `xdg-open`
 */
export function openerArgv(target: string, platform: NodeJS.Platform = process.platform, wsl: boolean = isWsl): string[] {
    if (platform === "darwin") return ["open", target];
    if (platform === "win32") return ["cmd", "/c", "start", "", target];
    if (wsl) return ["wslview", target];
    return ["xdg-open", target];
}

/** True when `/proc/version` names a Microsoft kernel — the standard WSL fingerprint. Pure for testability. */
export function isWslVersion(procVersion: string): boolean {
    return procVersion.toLowerCase().includes("microsoft");
}

// Detected once at module load: WSL identity is fixed for the process lifetime, and the probe reads a
// virtual file that does not exist off-Linux. A read failure (any non-WSL host) is simply "not WSL".
const isWsl: boolean = (() => {
    if (process.platform !== "linux") return false;
    try {
        return isWslVersion(readFileSync("/proc/version", "utf8"));
    } catch {
        return false;
    }
})();

/**
 * The effectful edges {@link openExternal} drives, injectable so its argv selection, ENOENT degrade, and
 * WSL fallback are unit-testable without a real subprocess. Production omits `seams` and gets the detached
 * `Bun.spawn` + `wslpath -w` translation + the live platform/WSL facts.
 */
export type OpenSeams = {
    /** Spawn `cmd` detached with output ignored; MUST throw (as `Bun.spawn` does) when the binary is missing. */
    readonly spawn: (cmd: string[]) => void;
    /** Translate a WSL path to its Windows form via `wslpath -w`, or `null` when translation fails. */
    readonly toWindowsPath: (path: string) => string | null;
    /** The running platform (overridable for tests). */
    readonly platform: NodeJS.Platform;
    /** Whether the host is WSL (overridable for tests). */
    readonly wsl: boolean;
    /** `SSH_CONNECTION`, or `null` (overridable for tests). */
    readonly sshConnection: string | null;
    /** Whether an X11 or a Wayland display is set (overridable for tests). */
    readonly display: boolean;
    /** The browser setting, read at each open (overridable for tests). */
    readonly browser: () => BrowserMode;
};

/** Detached spawn: the opener must not keep the CLI's event loop alive (`.unref()`), and its output is discarded. */
function spawnDetached(cmd: string[]): void {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" }).unref();
}

/** Translate a WSL path to Windows form (`wslpath -w`); `null` on any failure so the fallback can bail cleanly. */
function wslpathWindows(path: string): string | null {
    try {
        const out = Bun.spawnSync(["wslpath", "-w", path]).stdout.toString().trim();
        return out.length > 0 ? out : null;
    } catch {
        return null;
    }
}

const realSeams: OpenSeams = {
    spawn: spawnDetached,
    toWindowsPath: wslpathWindows,
    platform: process.platform,
    wsl: isWsl,
    sshConnection: terminalEnv.sshConnection,
    display: terminalEnv.display,
    browser: browserMode,
};

/**
 * Open `target` (file, directory, or URL) in the default OS application, detached. Returns `ok` once the
 * opener is spawned and `err` (never a throw) when the opener binary is missing or the spawn fails, so the
 * caller can show the path for manual opening. Under WSL, a missing `wslview` falls back to `explorer.exe`
 * with a `wslpath -w` translated path before giving up. A session with no display runs no opener, and gives
 * `no_display`.
 */
export function openExternal(target: string, seams: OpenSeams = realSeams): Result<void, OpenExternalError> {
    if (seams.browser() === "never") return err({ type: "no_display", reason: "disabled" });
    const noDisplay = noDisplayReason(seams);
    if (noDisplay !== null) return err({ type: "no_display", reason: noDisplay });
    try {
        seams.spawn(openerArgv(target, seams.platform, seams.wsl));
        return ok(undefined);
    } catch (cause) {
        // WSL fallback: `wslview` is optional, so a failed primary spawn there retries through Windows'
        // own opener with a translated path before surfacing the error.
        if (seams.wsl) {
            const win = seams.toWindowsPath(target);
            if (win !== null) {
                try {
                    seams.spawn(["explorer.exe", win]);
                    return ok(undefined);
                } catch (fallbackCause) {
                    return err({ type: "open_failed", code: errnoCode(fallbackCause) ?? null, cause: fallbackCause });
                }
            }
        }
        return err({ type: "open_failed", code: errnoCode(cause) ?? null, cause });
    }
}

/**
 * One line that tells the person how to open `target` by hand, after {@link openExternal} gave `e`. Over SSH, a
 * URL of a loopback port of this machine needs a port-forward first, thus the line gives the `ssh -L` command.
 */
export function openByHandHint(e: OpenExternalError, target: string): string {
    switch (e.type) {
        case "open_failed":
            return `Could not start an opener. Open it by hand: ${target}`;
        case "no_display": {
            if (e.reason === "disabled") return `The browser setting is \`never\` (INFLEXA_BROWSER or \`browser\` in config.json). Open it by hand: ${target}`;
            if (e.reason === "headless") return `This machine has no display, thus no window opens here. Open it by hand: ${target}`;
            const port = loopbackPort(target);
            const forward = port === null ? "" : ` On your computer, forward the port first: ${sshForwardCommand(port)}`;
            return `This session runs through SSH, thus no window opens here. Open it by hand: ${target}${forward}`;
        }
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled open error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * The line that a sign-in prints when no browser opened for its URL. It names the browser setting: a person who
 * signs in over SSH or on a server sets `never`, and the sign-in then tries no browser at all.
 */
export function signInOpenHint(e: OpenExternalError, url: string): string {
    if (e.type === "no_display" && e.reason === "disabled") {
        return `No browser opens, because the browser setting is \`never\` (${BROWSER_SETTING}). Open the URL by hand: ${url}`;
    }
    return `${openByHandHint(e, url)}\nTo skip the browser for each sign-in, set ${BROWSER_SETTING}.`;
}

/** The port of an `http` URL of a loopback address, or `null` for each other target. */
function loopbackPort(target: string): number | null {
    if (!URL.canParse(target)) return null;
    const url = new URL(target);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return url.port === "" ? 80 : Number(url.port);
}
