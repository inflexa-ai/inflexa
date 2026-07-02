import { createContext, createEffect, For, onCleanup, Show, useContext } from "solid-js";
import type { JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { randomUUIDv7 } from "bun";

import { zIndex } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { pushMode, MODE_MODAL, useBindings, KEYS, type LayerConfig } from "../../keymap.ts";

/**
 * Why a dialog left the stack — the single vocabulary every dismissal path speaks:
 * - `cancel`: the user backed out (esc).
 * - `dismiss`: the dialog was pushed aside without a decision (click-outside, ctrl+c, sweeps).
 * - `commit`: an affirmative flow closed it. This is the DEFAULT for bare programmatic
 *   `dialogClose()` calls because they sit at the tail of submit/select handlers; gesture
 *   paths always pass their reason explicitly.
 */
export type CloseReason = "cancel" | "dismiss" | "commit";

/**
 * A single entry on the dialog stack. `render`/`onClose` come from the pusher; the remaining
 * slots are registered by the CONTENT component after mount via {@link useDialogEntry} —
 * `contentOnClose` is how a dialog's `onCancel` prop hooks into the funnel without the pusher
 * wiring anything, `onRequestClose` is the veto (busy prompts), and `initialFocus`/`coveredFocus`
 * drive the host-owned focus choreography.
 */
type DialogEntry = {
    id: string;
    render: () => JSX.Element;
    onClose?: (reason: CloseReason) => void;
    contentOnClose?: (reason: CloseReason) => void;
    onRequestClose?: (reason: CloseReason) => boolean;
    initialFocus?: Renderable | null;
    coveredFocus?: Renderable | null;
};

// Module-level reactive state — the same pattern as the mode stack in keymap.ts and the
// notice/status stores in hooks/. A module-level store avoids the Provider-wrapping headache
// (opentui's render root expects a single element) while giving every component import-level
// access to the dialog API.
const [stack, setStack] = createStore<DialogEntry[]>([]);

// The renderer whose focus the host choreographs. Captured by DialogOverlay (render it ONCE per
// renderer — a second overlay on the same renderer would double-render the stack) and read by the
// push/close paths, which run outside any component.
let overlayRenderer: ReturnType<typeof useRenderer> | null = null;

// The app-level renderable focused before the first dialog opened; restored at N→0. Saved in
// dialogPush (synchronously, BEFORE the new entry mounts) so a mount-time focus grab by the
// dialog's own input can never be mistaken for the app's focus.
let savedAppFocus: Renderable | null = null;

// True while onClose callbacks are being dispatched. Caller-supplied onCancel/onClose bodies
// historically end with `ws.closeDialog()`; when the funnel itself invoked them, that nested
// close would pop the dialog BELOW the one being closed. Swallowing nested closes during
// dispatch keeps those callers correct without edits.
let dispatching = false;

// Click-outside gesture state, shared between the overlay's scrim handlers and DialogPanel's
// containment handlers (module-level because the panel — not the overlay — knows its own bounds;
// see dialogPanelMouseDown/Up).
// Whether the current mouse gesture began on the scrim (down outside the panel).
let downOutside = false;
// Whether the mouseDown was over a text selection (skip dismiss on the matching mouseUp).
let dismissGuard = false;

/**
 * Click containment for the dialog panel chrome: DialogPanel wires these to its root box so
 * presses/clicks inside the panel neither dismiss nor count as an outside mouse-down. They live
 * here (not in the overlay) because the per-entry wrapper is a full-inset box — only the panel
 * itself knows where "inside" ends. Harmless no-ops when the panel renders outside the host.
 */
export function dialogPanelMouseDown(e: { stopPropagation(): void }): void {
    downOutside = false;
    e.stopPropagation();
}

/** See {@link dialogPanelMouseDown}. */
export function dialogPanelMouseUp(e: { stopPropagation(): void }): void {
    dismissGuard = false;
    e.stopPropagation();
}

/** Blur whoever holds focus and record them for restore: the covered top entry, or the app at 0→1. */
function captureFocusForPush(): void {
    const focused = overlayRenderer?.currentFocusedRenderable ?? null;
    if (stack.length > 0) {
        setStack(stack.length - 1, "coveredFocus", focused);
    } else if (savedAppFocus === null) {
        savedAppFocus = focused;
    }
    focused?.blur();
}

/** Focus a renderable on the next microtask, guarded against death/removal in the meantime. */
function focusSoon(target: Renderable | null | undefined): void {
    if (!target) return;
    queueMicrotask(() => {
        if (target.isDestroyed) return;
        if (overlayRenderer?.root.findDescendantById(target.id) === undefined) return;
        target.focus();
    });
}

// ── public API ────────────────────────────────────────────────────────────────

/** Push a dialog onto the stack. Lower entries stay mounted (hidden and inert) — see DialogOverlay. */
export function dialogPush(render: () => JSX.Element, onClose?: (reason: CloseReason) => void): void {
    captureFocusForPush();
    setStack(produce((s) => s.push({ id: randomUUIDv7(), render, onClose })));
}

/**
 * Close the top dialog through the funnel. Returns false when the entry's `onRequestClose`
 * vetoed the close (e.g. a busy prompt) — callers with an escalation tier (the app abort chord)
 * branch on it. Nested calls from within onClose dispatch are swallowed (see `dispatching`).
 */
export function dialogClose(reason: CloseReason = "commit"): boolean {
    if (dispatching) return true;
    if (stack.length === 0) return true;
    const top = stack[stack.length - 1]!;
    if (top.onRequestClose && !top.onRequestClose(reason)) return false;
    setStack(produce((s) => s.pop()));
    dispatching = true;
    try {
        top.contentOnClose?.(reason);
        top.onClose?.(reason);
    } finally {
        dispatching = false;
    }
    // Reveal: the entry beneath gets back whatever it had focused when it was covered.
    const revealed = stack[stack.length - 1];
    if (revealed) focusSoon(revealed.coveredFocus ?? revealed.initialFocus);
    return true;
}

/** Fire every entry's close hooks (top-down, reason `dismiss`) and empty the stack. Sweeps are authoritative: vetoes are not consulted. */
export function dialogClear(): void {
    if (stack.length === 0) return;
    const current = [...stack];
    setStack([]);
    dispatching = true;
    try {
        for (let i = current.length - 1; i >= 0; i--) {
            current[i]!.contentOnClose?.("dismiss");
            current[i]!.onClose?.("dismiss");
        }
    } finally {
        dispatching = false;
    }
}

/**
 * Replace the entire stack with one new dialog: sweep every existing entry (reason `dismiss`),
 * then push the new one. The "show me exactly this dialog" semantic for imperative `.show()`
 * patterns where the prior stack doesn't matter.
 */
export function dialogReplace(render: () => JSX.Element, onClose?: (reason: CloseReason) => void): void {
    dialogClear();
    dialogPush(render, onClose);
}

/** True when at least one dialog is on the stack. Reactive (reads the store length). */
export function dialogIsOpen(): boolean {
    return stack.length > 0;
}

/** The top dialog's render thunk, or `null` when the stack is empty. Reactive. */
export function dialogTop(): (() => JSX.Element) | null {
    return stack.length > 0 ? stack[stack.length - 1]!.render : null;
}

// ── entry context ─────────────────────────────────────────────────────────────

/**
 * The host-provided handle a dialog content component uses to participate in the state machine:
 * declare its initial focus target, veto closes, and hook its cancel prop into the close funnel.
 */
export type DialogEntryHandle = {
    /** True while this entry is the top of the stack. Reactive. */
    isTop: () => boolean;
    /**
     * Declare the renderable the host focuses when this entry is (or becomes) top. Replaces
     * per-dialog mount-time focus microtasks — the host owns when focus lands.
     */
    setInitialFocus: (r: Renderable | null) => void;
    /** Register the close veto: return false to keep the dialog open for that reason. */
    setRequestClose: (fn: (reason: CloseReason) => boolean) => void;
    /**
     * Register the content-side close listener, fired (before the pusher's `onClose`) on every
     * funnel close. Dialogs wire their `onCancel`-style props here, typically gated on
     * `reason !== "commit"`.
     */
    setOnClose: (fn: (reason: CloseReason) => void) => void;
};

const DialogEntryContext = createContext<DialogEntryHandle>();

/**
 * This dialog's entry handle, or `null` when the component renders outside the host (the design
 * gallery embeds dialog components inside ITS entry; a null handle keeps such showcases inert).
 */
export function useDialogEntry(): DialogEntryHandle | null {
    return useContext(DialogEntryContext) ?? null;
}

/**
 * `useBindings` for dialog layers: ANDs the layer's `enabled` with the entry's `isTop`, so a
 * stacked dialog suspends the keys of everything beneath it — the depth gating the mode stack
 * cannot express (modal-over-modal is "modal" both times). Outside any entry the gate falls back
 * to `!dialogIsOpen()`: a screen-level layer (standalone config) suspends while a dialog covers
 * it, and a gallery-embedded dialog showcase stays inert. The keymap engine stays dialog-agnostic
 * — this is an ordinary reactive `enabled` input.
 */
export function useDialogBindings(config: () => LayerConfig): void {
    const handle = useDialogEntry();
    useBindings(() => {
        const c = config();
        const gate = handle ? handle.isTop() : !dialogIsOpen();
        return { ...c, enabled: (c.enabled ?? true) && gate };
    });
}

/**
 * Register this dialog's close listener with the funnel: `fn(reason)` fires (before the pusher's
 * `onClose`) on EVERY close — esc, click-outside, ctrl+c, programmatic. No-op outside the host
 * (gallery-embedded showcases). Most dialogs want {@link useDialogCancel} instead.
 */
export function useDialogClose(fn: (reason: CloseReason) => void): void {
    useDialogEntry()?.setOnClose(fn);
}

/**
 * The common close-listener shape: run `fn` when the dialog closes WITHOUT a commit (esc,
 * click-outside, ctrl+c) — i.e. wire a dialog's `onCancel`-style prop into the funnel.
 */
export function useDialogCancel(fn: () => void): void {
    useDialogClose((reason) => {
        if (reason !== "commit") fn();
    });
}

/**
 * Register this dialog's close veto: return false from `fn` to keep the dialog open for that
 * close attempt (busy prompts, dirty forms). Sweeps (`dialogClear`/`dialogReplace`) bypass it.
 */
export function useDialogCloseGuard(fn: (reason: CloseReason) => boolean): void {
    useDialogEntry()?.setRequestClose(fn);
}

function makeHandle(id: string): DialogEntryHandle {
    const index = (): number => stack.findIndex((e) => e.id === id);
    const isTop = (): boolean => stack.length > 0 && stack[stack.length - 1]!.id === id;
    return {
        isTop,
        setInitialFocus(r: Renderable | null): void {
            const i = index();
            if (i < 0) return;
            setStack(i, "initialFocus", r);
            if (isTop()) focusSoon(r);
        },
        setRequestClose(fn: (reason: CloseReason) => boolean): void {
            const i = index();
            if (i < 0) return;
            // Wrapped in a thunk: a bare function value would be treated as a store UPDATER.
            setStack(i, "onRequestClose", () => fn);
        },
        setOnClose(fn: (reason: CloseReason) => void): void {
            const i = index();
            if (i < 0) return;
            setStack(i, "contentOnClose", () => fn);
        },
    };
}

// Never-top, all-noop handle: showcased dialogs read it instead of the surrounding entry's.
const INERT_HANDLE: DialogEntryHandle = {
    isTop: () => false,
    setInitialFocus: () => {},
    setRequestClose: () => {},
    setOnClose: () => {},
};

/**
 * Render dialog components as inert exhibits (the design gallery): children see a never-top entry
 * handle, so their key layers stay suspended, they grab no focus, and their close hooks attach to
 * nothing — instead of hijacking the SURROUNDING dialog's entry (the gallery is itself a dialog,
 * and without this barrier a showcased prompt would register its input as the gallery's initial
 * focus and kill the gallery's scroll keys).
 */
export function DialogShowcase(props: { children: JSX.Element }): JSX.Element {
    return <DialogEntryContext.Provider value={INERT_HANDLE}>{props.children}</DialogEntryContext.Provider>;
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
 * content. Render this ONCE per renderer inside the app's root box (not in a Portal — a Portal's
 * wrapper box has no size, so absolute insets collapse). It pushes {@link MODE_MODAL} while any
 * dialog is open, so the entire base-UI keymap goes inert with no per-binding `if (dialogOpen)`.
 *
 * State-machine responsibilities:
 * - **Every entry stays mounted**: non-top entries render with `visible={false}` (yoga
 *   `display: none` — no layout footprint, auto-blur) so their component state survives being
 *   covered; only the top entry is painted and only its key layers are live (`useDialogBindings`).
 * - **The structural esc key**: one host-owned layer closes the top entry with reason `cancel`;
 *   content dialogs bind no esc of their own.
 * - **Focus**: push captures + blurs the covered focus (see {@link captureFocusForPush}); close
 *   restores it on reveal; the app's focus is restored at N→0 (with a tree-walk guard). The app's
 *   focus model keeps focus on some widget at all times, so there is no fallback machinery.
 * - **Click-outside**: dismisses (reason `dismiss`) only when BOTH mouse-down and mouse-up land
 *   on the scrim — a press inside the panel dragged out is not a dismissal — with a selection
 *   guard (a text-selection drag release does not dismiss). Clicks inside the panel stop
 *   propagation, staying capturable by inner components.
 */
export function DialogOverlay(): JSX.Element {
    const renderer = useRenderer();
    overlayRenderer = renderer;
    onCleanup(() => {
        overlayRenderer = null;
    });

    // Restore the app's focus when the last dialog closes.
    createEffect(() => {
        if (stack.length !== 0 || savedAppFocus === null) return;
        const target = savedAppFocus;
        savedAppFocus = null;
        // Defer so the unmounting dialog's cleanup runs first.
        setTimeout(() => {
            // A dialog opened during the deferred gap — the close-then-open command chain (the
            // palette closes, then the selected command pushes its own dialog in the same tick).
            // That dialog's initial focus wins; restoring here would steal it 1ms after it landed.
            // Re-park the target as the saved app focus (captureFocusForPush saw an empty focus
            // during the gap, so the 0→1 save was null) so the eventual real N→0 close still
            // restores the app.
            if (stack.length > 0) {
                if (savedAppFocus === null) savedAppFocus = target;
                return;
            }
            if (target.isDestroyed) return;
            // Verify the renderable is still in the tree before refocusing.
            if (renderer.root.findDescendantById(target.id) === undefined) return;
            target.focus();
        }, 1);
    });

    // MODE_MODAL: suspend the base-UI keymap while any dialog is open.
    createEffect(() => {
        if (stack.length === 0) return;
        const pop = pushMode(MODE_MODAL);
        onCleanup(pop);
    });

    // The single structural esc: close the top entry as a cancel. Content dialogs do not bind esc.
    useBindings(() => ({
        enabled: stack.length > 0,
        bindings: [{ chord: KEYS.escape, run: () => void dialogClose("cancel"), desc: "Close dialog", group: "Dialog" }],
    }));

    return (
        <Show when={stack.length > 0}>
            <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                zIndex={zIndex.modal}
                onMouseDown={() => {
                    downOutside = true;
                    dismissGuard = !!renderer.getSelection();
                }}
                onMouseUp={() => {
                    // Dismiss only a full outside click: down on the scrim, up on the scrim, no selection drag.
                    const shouldDismiss = downOutside && !dismissGuard;
                    downOutside = false;
                    dismissGuard = false;
                    if (shouldDismiss) void dialogClose("dismiss");
                }}
            >
                <box position="absolute" top={0} left={0} right={0} bottom={0} backgroundColor={theme().bg} opacity={0.92} />
                <For each={stack}>
                    {(entry) => (
                        <DialogEntryContext.Provider value={makeHandle(entry.id)}>
                            {/* Full-inset, self-centering wrapper — deliberately NOT an auto-sized
                                box around the panel: yoga resolves the panel's percentage
                                maxWidth/maxHeight against its PARENT, and an indefinite parent
                                squeezes the panel below its content (paddings and auto-height
                                children collapse first). Click containment lives on DialogPanel
                                (see dialogPanelMouseDown/Up), which knows the panel's bounds. */}
                            <box
                                position="absolute"
                                top={0}
                                left={0}
                                right={0}
                                bottom={0}
                                alignItems="center"
                                justifyContent="center"
                                visible={entry.id === stack[stack.length - 1]?.id}
                            >
                                {entry.render()}
                            </box>
                        </DialogEntryContext.Provider>
                    )}
                </For>
            </box>
        </Show>
    );
}
