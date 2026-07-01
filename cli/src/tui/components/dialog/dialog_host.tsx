import { createEffect, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";

import { zIndex } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { pushMode, MODE_MODAL } from "../../keymap.ts";

/**
 * A single entry on the dialog stack: the render thunk that produces the content component, and
 * an optional cleanup/dismiss callback fired when the entry is popped (by {@link dialogClose}) or
 * swept (by {@link dialogClear}/{@link dialogReplace}). The `onClose` hook is the mechanism behind
 * the imperative `.show()` promise pattern: the caller passes a `resolve` and the promise settles
 * whether the user confirms, cancels, or hits escape.
 */
type DialogEntry = {
    render: () => JSX.Element;
    onClose?: () => void;
};

// Module-level reactive state — the same pattern as the mode stack in keymap.ts and the
// notice/status stores in hooks/. A module-level store avoids the Provider-wrapping headache
// (opentui's render root expects a single element) while giving every component import-level
// access to the dialog API.
const [stack, setStack] = createStore<DialogEntry[]>([]);

// ── public API ────────────────────────────────────────────────────────────────

/** Push a dialog onto the stack. The top entry is the one rendered. */
export function dialogPush(render: () => JSX.Element, onClose?: () => void): void {
    setStack(produce((s) => s.push({ render, onClose })));
}

/**
 * Replace the entire stack with one new dialog: fire every existing entry's `onClose`, clear, then
 * push the new entry. The "show me exactly this dialog" semantic — useful for imperative `.show()`
 * patterns where the prior stack doesn't matter.
 */
export function dialogReplace(render: () => JSX.Element, onClose?: () => void): void {
    const current = [...stack];
    setStack([{ render, onClose }]);
    for (const entry of current) entry.onClose?.();
}

/** Pop the top dialog and fire its `onClose` (if any). No-op when the stack is empty. */
export function dialogClose(): void {
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    setStack(produce((s) => s.pop()));
    top?.onClose?.();
}

/** Fire every entry's `onClose` and empty the stack. */
export function dialogClear(): void {
    const current = [...stack];
    setStack([]);
    for (const entry of current) entry.onClose?.();
}

/** True when at least one dialog is on the stack. Reactive (reads the store length). */
export function dialogIsOpen(): boolean {
    return stack.length > 0;
}

/** The top dialog's render thunk, or `null` when the stack is empty. */
export function dialogTop(): (() => JSX.Element) | null {
    return stack.length > 0 ? stack[stack.length - 1]!.render : null;
}

// ── convenience hook ──────────────────────────────────────────────────────────

/** The dialog API as a plain object — a convenience wrapper over the module-level functions. */
export type DialogApi = {
    push: typeof dialogPush;
    replace: typeof dialogReplace;
    close: typeof dialogClose;
    clear: typeof dialogClear;
    isOpen: typeof dialogIsOpen;
};

/**
 * Return the dialog API. Unlike OpenCode's context-based `useDialog()`, this reads module-level
 * state — no Provider wrapping required. Safe to call anywhere a Solid component runs.
 */
export function useDialog(): DialogApi {
    return { push: dialogPush, replace: dialogReplace, close: dialogClose, clear: dialogClear, isOpen: dialogIsOpen };
}

// ── overlay component ─────────────────────────────────────────────────────────

/**
 * The dialog overlay: a full-screen absolute scrim that dims the app and centers the top dialog's
 * content. Render this ONCE inside the app's root box (not in a Portal — a Portal's wrapper box
 * has no size, so absolute insets collapse). It pushes {@link MODE_MODAL} while any dialog is
 * open, so the entire base-UI keymap goes inert with no per-binding `if (dialogOpen)`.
 *
 * Also handles:
 * - **Focus save/restore**: captures the focused renderable when the first dialog opens, restores
 *   it (with a tree-walk guard) when the last dialog closes. Ported from OpenCode's dialog.tsx.
 *   The app's focus model keeps focus on some widget at all times (chat: the textarea in INSERT,
 *   the stream's ScrollPane in NORMAL — see app.tsx), so there is no nothing-focused case to fall
 *   back from and no fallback machinery.
 * - **Click-outside-to-dismiss**: clicking the scrim outside the content panel closes the dialog,
 *   with a selection guard (a text-selection drag release does not dismiss). Dismissal routes
 *   through {@link dialogClose}, which fires the top entry's `onClose` — the single dismiss hook.
 *   Callers that need cleanup on dismiss (releasing a lock, reverting optimistic state) wire it
 *   through `onClose` at `dialogPush` time, not through the content component's `onCancel`.
 */
export function DialogOverlay(): JSX.Element {
    const renderer = useRenderer();
    let savedFocus: Renderable | null = null;
    // Whether the mouseDown was over a text selection (skip dismiss on the matching mouseUp).
    let dismissGuard = false;

    // Focus save/restore: capture when 0→N, restore when N→0.
    createEffect(() => {
        if (stack.length > 0 && savedFocus === null) {
            savedFocus = renderer.currentFocusedRenderable;
            savedFocus?.blur();
        }
        if (stack.length === 0 && savedFocus !== null) {
            const target = savedFocus;
            savedFocus = null;
            // Defer so the unmounting dialog's cleanup runs first.
            setTimeout(() => {
                if (target.isDestroyed) return;
                // Verify the renderable is still in the tree before refocusing.
                if (renderer.root.findDescendantById(target.id) === undefined) return;
                target.focus();
            }, 1);
        }
    });

    // MODE_MODAL: suspend the base-UI keymap while any dialog is open.
    createEffect(() => {
        if (stack.length === 0) return;
        const pop = pushMode(MODE_MODAL);
        onCleanup(pop);
    });

    return (
        <Show when={dialogTop()} keyed>
            {(render: () => JSX.Element) => (
                <box
                    position="absolute"
                    top={0}
                    left={0}
                    right={0}
                    bottom={0}
                    zIndex={zIndex.modal}
                    alignItems="center"
                    justifyContent="center"
                    onMouseDown={() => {
                        dismissGuard = !!renderer.getSelection();
                    }}
                    onMouseUp={() => {
                        // A text-selection drag that ended over the scrim: clear the selection instead of dismissing.
                        if (dismissGuard) {
                            dismissGuard = false;
                            return;
                        }
                        dialogClose();
                    }}
                >
                    <box position="absolute" top={0} left={0} right={0} bottom={0} backgroundColor={theme().bg} opacity={0.92} />
                    {/* Stop propagation on the content panel so clicks inside the dialog don't trigger
                        the scrim's dismiss handler above. */}
                    <box
                        onMouseUp={(e: { stopPropagation(): void }) => {
                            dismissGuard = false;
                            e.stopPropagation();
                        }}
                    >
                        {render()}
                    </box>
                </box>
            )}
        </Show>
    );
}
