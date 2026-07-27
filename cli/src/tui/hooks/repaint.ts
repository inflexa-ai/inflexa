import { onCleanup } from "solid-js";
import type { CliRenderer } from "@opentui/core";

// Recovery from screen damage the app cannot see.
//
// OpenTUI renders DIFFS: each frame it compares the next buffer against a shadow buffer of what it
// believes is on the terminal, and writes only the cells that changed. Verified against 0.4.2 in a
// pty: a re-render with unchanged content emits ZERO bytes.
//
// So anything that wipes the terminal's screen WITHOUT going through the renderer leaves the shadow
// buffer lying — every surviving cell is "already correct" and is never rewritten, and the UI stays
// blank until something happens to change it. The reproducible case is macOS Terminal.app's ⌘K
// ("Clear to Start", the `clearAll:` menu action — NOT "Clear Scrollback", which is a separate,
// unbound item): it scrolls the visible alternate screen into scrollback and leaves a blank
// viewport. Terminal.app is a menu action, so the app is sent no bytes, gets no SIGWINCH and no
// focus change — there is no signal to react to. ⌘K is a plausible mis-keypress here precisely
// because the command palette is ctrl+k.
//
// The remedy is therefore a repaint the USER can cause, either explicitly (the `app.redraw` key) or
// as a side effect of touching the keyboard at all ({@link watchScreenDamage}).

/**
 * Invalidate the renderer's shadow buffer so the next frame rewrites every cell.
 *
 * Measured on a 200x50 alternate screen: ~13 KB, wrapped in synchronized-output (`CSI ?2026h`) so it
 * lands atomically with no flicker, and it does not leave the alternate screen. The flag is one-shot
 * — the renderer resets it after the frame it applies to — so this is safe to call at any time.
 */
export function forceFullRepaint(renderer: CliRenderer): void {
    // `forceFullRepaintRequested` is PRIVATE in @opentui/core's typings and there is no public
    // equivalent (checked in the pinned 0.4.2 and in the current 0.4.5 — neither exposes a
    // redraw/repaint method). Sound because it is a plain boolean the render loop reads once per
    // frame and clears itself; writing it grants exactly the `force` argument the native renderer
    // already takes, with no other state touched. `repaint.render.test.tsx` asserts the field exists
    // on a real renderer, so an upgrade that renames it fails the suite instead of silently
    // reverting this fix to a no-op.
    //
    // The two public alternatives were both measured and rejected:
    //   - `suspend()` + `resume()` sets the same flag, but leaves AND re-enters the alternate screen
    //     (emits `CSI ?1049l` then `CSI ?1049h`) — a visible flash, and on Terminal.app leaving the
    //     alternate screen dumps the frame into scrollback, i.e. it re-causes the very symptom.
    //   - jiggling `resize()` to a different size and back does force the repaint, but relayouts the
    //     whole tree at a wrong size for one pass and emits spurious `resized` events that every
    //     `useTerminalDimensions` consumer would observe. Layout bugs here are size-dependent
    //     (CLAUDE.md → "Layout (flex)"), so a transient wrong size is not a safe thing to inflict.
    (renderer as unknown as { forceFullRepaintRequested: boolean }).forceFullRepaintRequested = true;
    renderer.requestRender();
}

/**
 * How long the keyboard must have been quiet before the next keystroke is treated as a possible
 * "my screen is broken" probe. Chosen to sit above human typing cadence (inter-key gaps while
 * actually typing are well under 500ms, so a typing burst forces no repaints) and far below how long
 * someone stares at a wiped screen before touching anything.
 */
export const REPAINT_IDLE_GAP_MS = 500;

/**
 * Self-heal a screen wiped behind the renderer's back: force a full repaint on the first keystroke
 * after the keyboard has been idle for {@link REPAINT_IDLE_GAP_MS}.
 *
 * This is what makes the failure recoverable for someone who does not know a redraw key exists —
 * they press anything and the UI comes back. Gating on an idle gap is what keeps it free: the wipe
 * is necessarily followed by a pause (the user has to notice the blank screen), while continuous
 * typing never crosses the gap and so never pays for a full frame.
 *
 * This subscribes to the key bus as a pure OBSERVER — it never inspects which key was pressed and
 * never calls `preventDefault`, so it is not a binding and does not belong in the keymap engine
 * (CLAUDE.md → keymap: bindings are data dispatched centrally). `now` is injectable so the test can
 * drive the clock instead of sleeping.
 *
 * Not covered, by construction: damage that is never followed by a keystroke. If the wipe happens
 * mid-turn, streamed output repaints only the cells it changes, so text appears on an otherwise
 * blank screen until the user touches the keyboard. Detecting that would need either a polling
 * repaint (which would defeat on-demand rendering — the renderer costs no frames while idle) or a
 * damage notification no terminal sends.
 */
export function watchScreenDamage(renderer: CliRenderer, opts?: { now?: () => number }): void {
    const now = opts?.now ?? (() => Date.now());
    let lastKeyAt = now();

    const onKeypress = (): void => {
        const at = now();
        const idle = at - lastKeyAt;
        lastKeyAt = at;
        if (idle >= REPAINT_IDLE_GAP_MS) forceFullRepaint(renderer);
    };

    renderer.keyInput.on("keypress", onKeypress);
    onCleanup(() => renderer.keyInput.off("keypress", onKeypress));
}
