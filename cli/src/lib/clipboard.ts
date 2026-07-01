import { terminalEnv } from "./env.ts";
import { getLogger } from "./log.ts";

const log = getLogger("clipboard");

// Select-to-copy clipboard writer (see TEXT-SELECTION-CLIPBOARD-REPORT.md §3). Every write does BOTH an
// OSC 52 escape and a native OS tool, because neither alone covers every case: OSC 52 reaches the local
// terminal even over SSH; the native tool reaches the GUI clipboard and has no payload-size cap.

/**
 * Build the OSC 52 "set clipboard" escape for `text`, wrapped in the tmux/screen DCS passthrough when
 * `multiplexed` (the multiplexer swallows a bare OSC 52). `c` targets the clipboard (vs `p` = X11
 * primary); the payload is base64. Pure (no stdout/env) so the escape encoding — the subtle part that
 * silently corrupts the terminal or clipboard if a byte is wrong — is unit-testable.
 */
export function osc52Sequence(text: string, multiplexed: boolean): string {
    const seq = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
    return multiplexed ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq;
}

/** Emit the OSC 52 escape to stdout. No-op when stdout is not a TTY, so it never leaks into piped output. */
function writeOsc52(text: string): void {
    if (!process.stdout.isTTY) return;
    process.stdout.write(osc52Sequence(text, terminalEnv.multiplexed));
}

/**
 * The native clipboard command for a platform (text arrives on the tool's stdin), or undefined when
 * no tool is known. macOS uses `pbcopy` — simpler than OpenCode's `osascript` and fine here, since
 * the OSC 52 path covers any escaping edge cases the report flags for AppleScript literals. Pure
 * (platform + wayland passed in) so the mapping is unit-testable without touching the real process.
 */
export function nativeCopyCommand(platform: typeof process.platform, wayland: boolean): string[] | undefined {
    if (platform === "darwin") return ["pbcopy"];
    if (platform === "win32") return ["clip"];
    // Linux: Wayland and X11 need different tools; xclip is the common X11 fallback.
    if (wayland) return ["wl-copy"];
    return ["xclip", "-selection", "clipboard"];
}

/**
 * Copy `text` to the clipboard via OSC 52 AND the native OS tool. Best-effort: a missing native tool
 * (`xclip`/`wl-copy` not installed → spawn throws ENOENT) is swallowed so it never crashes the TUI —
 * the OSC 52 path may still have succeeded, and copy is convenience feedback, not a critical path.
 */
export async function writeClipboard(text: string): Promise<void> {
    writeOsc52(text);
    const cmd = nativeCopyCommand(process.platform, terminalEnv.wayland);
    if (!cmd) return;
    try {
        // Bun streams the Blob in as the child's stdin; the tool reads it and sets the clipboard.
        const proc = Bun.spawn({ cmd, stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" });
        await proc.exited;
    } catch (err) {
        // `err` is an unknown spawn failure (typically ENOENT — tool not installed). Logged, not thrown.
        log.debug({ err, cmd }, "native clipboard copy failed");
    }
}
