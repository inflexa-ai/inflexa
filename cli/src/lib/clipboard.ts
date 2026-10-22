import { err, ok, type Result } from "neverthrow";

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
 * Why the native clipboard tool set nothing. OSC 52 gives no acknowledgement, thus this verdict is the only
 * evidence that a copy reached the clipboard.
 */
export type ClipboardError = { type: "native_copy_failed" };

/** Run the platform's clipboard tool. A missing tool (spawn throws ENOENT) and a non-zero exit are both a failed copy. */
async function nativeCopy(text: string): Promise<Result<void, ClipboardError>> {
    const cmd = nativeCopyCommand(process.platform, terminalEnv.wayland);
    if (!cmd) return err({ type: "native_copy_failed" });
    try {
        // Bun streams the Blob in as the child's stdin; the tool reads it and sets the clipboard.
        const proc = Bun.spawn({ cmd, stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" });
        if ((await proc.exited) === 0) return ok(undefined);
        log.debug({ cmd, exitCode: proc.exitCode }, "native clipboard copy failed");
    } catch (cause) {
        // `cause` is an unknown spawn failure (typically ENOENT — tool not installed).
        log.debug({ err: cause, cmd }, "native clipboard copy failed");
    }
    return err({ type: "native_copy_failed" });
}

let nativeWriter: (text: string) => Promise<Result<void, ClipboardError>> = nativeCopy;

/**
 * Swap the native-tool leg for a double, returning its restore function. Mirrors the `__set…ForTest`
 * accessors elsewhere; production code never calls it.
 *
 * A copy has no other observable: the OSC 52 leg is a deliberate no-op off a TTY (so it never leaks
 * into piped output), and letting a test reach the real `pbcopy` would overwrite the clipboard of
 * whoever runs the suite — a side effect no assertion is worth.
 */
export function __setClipboardWriterForTest(next: (text: string) => Promise<Result<void, ClipboardError>>): () => void {
    const previous = nativeWriter;
    nativeWriter = next;
    return () => {
        nativeWriter = previous;
    };
}

/**
 * Copy `text` to the clipboard via OSC 52 AND the native OS tool. Gives `ok` only when the native tool set the
 * clipboard. A caller confirms the copy on `ok` and says nothing on `err`: the OSC 52 leg can still have set the
 * clipboard, but nothing tells whether it did, and a confirmation that can be false leaves the user with an
 * empty paste and no reason.
 */
export async function writeClipboard(text: string): Promise<Result<void, ClipboardError>> {
    writeOsc52(text);
    return nativeWriter(text);
}
