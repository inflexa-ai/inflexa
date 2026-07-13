import { readFileSync } from "node:fs";
import { err, ok, type Result } from "neverthrow";

// The single shared "open this in the default OS application" helper: every caller (auth login, analysis
// open, artifact open) routes through it, so per-platform opener selection — including the WSL case — lives
// in one place. A failed open never throws and never blocks a turn: it returns `Result` with the failure on
// the error channel, and every caller degrades to a notice carrying the path (the artifact-open spec's rule).

/**
 * Why an external open could not be spawned. `code` carries the OS error code when known (`ENOENT` for a
 * missing opener binary — a headless box without `xdg-open`) so a caller can distinguish "no opener" from
 * a transient spawn fault, though every caller degrades the same way: a notice with the path.
 */
export type OpenExternalError = { type: "open_failed"; code: string | null; cause: unknown };

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

const realSeams: OpenSeams = { spawn: spawnDetached, toWindowsPath: wslpathWindows, platform: process.platform, wsl: isWsl };

/** The OS error code a spawn failure carries, if any — `ENOENT` marks a missing opener binary. */
function errorCode(cause: unknown): string | null {
    return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : null;
}

/**
 * Open `target` (file, directory, or URL) in the default OS application, detached. Returns `ok` once the
 * opener is spawned and `err` (never a throw) when the opener binary is missing or the spawn fails, so the
 * caller can show the path for manual opening. Under WSL, a missing `wslview` falls back to `explorer.exe`
 * with a `wslpath -w` translated path before giving up.
 */
export function openExternal(target: string, seams: OpenSeams = realSeams): Result<void, OpenExternalError> {
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
                    return err({ type: "open_failed", code: errorCode(fallbackCause), cause: fallbackCause });
                }
            }
        }
        return err({ type: "open_failed", code: errorCode(cause), cause });
    }
}
