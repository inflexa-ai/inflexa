// The TUI keybinding engine: bindings are DATA, dispatched by a central router — never
// hand-written `if (key.name === "x" && state === y)`. Each feature *declares* a layer of
// bindings via `useBindings`, self-gated by a reactive `enabled` flag and/or a `mode`; the
// single root `useKeyboard` handler (`useKeymapRoot`) collects the currently-active layers and
// routes each keystroke to the winning binding. Opening a modal pushes a `mode` so the entire
// base-UI keymap goes inert at once, with no per-binding `if (dialogOpen)` anywhere.
//
// Adapted from OpenCode's `@opentui/keymap` (not a dependency here) to the right altitude for
// this app: a registry + mode stack + config-file remapping, but NO leader/chord sequences,
// which-key panel, or per-widget focus `target` — this app has one focusable slot at a time and
// ~10 bindings, so that machinery would be inert ceremony.
//
// Key chords are matched STRUCTURALLY against opentui's parsed key (so the rest of the module is
// opentui-type-free); only the root handler touches opentui, to wrap its keyboard bus. Display
// labels are DERIVED from the chord (`chordLabel`) — one source, never a hand-kept label/chord
// pair that can drift. Labels are platform-neutral and ALWAYS LOWERCASE (`ctrl+k`, `esc`),
// identical on macOS/Linux/Windows. Navigation chords use Ctrl, NOT Alt: terminals deliver
// Alt/Option unreliably (macOS composes Option into a character), and never Cmd (not forwarded).

import { randomUUIDv7 } from "bun";
import { createSignal, onCleanup } from "solid-js";
import { useKeyboard } from "@opentui/solid";

import { GLYPHS } from "../lib/glyphs.ts";
import { readConfig } from "../lib/config.ts";

/** A platform-neutral key chord, matched structurally against opentui's parsed key. */
export type Chord = {
    /** opentui key `name` (lowercase), e.g. `"k"`, `"up"`, `"return"`, `"escape"`. */
    key: string;
    /** Requires the Control modifier when true. */
    ctrl?: boolean;
    /** Requires the Option/Alt modifier when true (delivered as Meta in most terminals). */
    alt?: boolean;
};

/** The minimal shape of opentui's parsed key that {@link matchChord} reads. */
export type KeyLike = {
    /** Lowercase key name. */
    name: string;
    /** Control held. */
    ctrl: boolean;
    /** Meta held (terminals deliver Option/Alt here). */
    meta: boolean;
    /** Option held (the kitty protocol sets this alongside `meta`). */
    option: boolean;
};

/**
 * True when `ev` is the `chord`. Option/Alt is accepted from EITHER `option` or `meta` (terminals
 * deliver it inconsistently), for the rare binding that opts into Alt. Modifiers not required by
 * the chord must be absent.
 */
export function matchChord(chord: Chord, ev: KeyLike): boolean {
    const alt = ev.option || ev.meta;
    return ev.name === chord.key && (chord.ctrl ?? false) === ev.ctrl && (chord.alt ?? false) === alt;
}

// --- chord parsing & display ----------------------------------------------------------------

// User-typed key names → opentui's canonical name. Lets a config write the friendly `enter`/`esc`
// while the engine matches opentui's `return`/`escape` (the report's alias-expander, inlined).
const CANON: Record<string, string> = {
    enter: "return",
    esc: "escape",
    del: "delete",
    pgup: "pageup",
    pgdn: "pagedown",
};

// opentui key name → lowercase display label. Arrows render as glyphs (the gutter is fixed-width,
// so the glyph set is the single source — never inline a literal); everything else is shown as
// its friendly name. Keys absent here display verbatim (`k`, `b`, …).
const KEY_LABEL: Record<string, string> = {
    return: "enter",
    escape: "esc",
    up: GLYPHS.arrowUp,
    down: GLYPHS.arrowDown,
    left: GLYPHS.arrowLeft,
    right: GLYPHS.arrowRight,
    space: "space",
};

/**
 * Parse a key string (`"ctrl+k"`, `"enter"`, `"alt+enter"`) into a {@link Chord}. Best-effort and
 * total: an unparseable string yields a chord whose `key` never matches a real keystroke, which
 * simply disables that binding rather than throwing — a malformed user override degrades to "no
 * binding", never a crash. `opt`/`option` are accepted as aliases for `alt`.
 */
export function parseChord(s: string): Chord {
    const parts = s.toLowerCase().split("+");
    const key = parts.pop() ?? "";
    return {
        key: CANON[key] ?? key,
        ctrl: parts.includes("ctrl"),
        alt: parts.includes("alt") || parts.includes("opt") || parts.includes("option"),
    };
}

/** The lowercase, platform-neutral display label for a chord, e.g. `ctrl+k`, `alt+enter`, `↑`. */
export function chordLabel(chord: Chord): string {
    const parts: string[] = [];
    if (chord.ctrl) parts.push("ctrl");
    if (chord.alt) parts.push("alt");
    parts.push(KEY_LABEL[chord.key] ?? chord.key);
    return parts.join("+");
}

// --- canonical structural chords ------------------------------------------------------------

/**
 * Canonical chords for structural navigation shared across dialogs/config (cursor moves, submit,
 * cancel). These are deliberately NOT remappable — they are conventional and not worth a config
 * surface (the report's inline-`cmd` split: behavior that should not be remapped). Reference these
 * instead of writing `{ key: "up" }` at each site, so the chord — and thus its derived label — has
 * one source.
 */
export const KEYS = {
    up: { key: "up" },
    down: { key: "down" },
    left: { key: "left" },
    right: { key: "right" },
    enter: { key: "return" },
    escape: { key: "escape" },
    space: { key: "space" },
    q: { key: "q" },
    // Emacs-style cursor alternates, so the list keys work without leaving the home row.
    prevAlt: { key: "p", ctrl: true },
    nextAlt: { key: "n", ctrl: true },
} as const satisfies Record<string, Chord>;

/** Submit the chat message (textarea-level; see {@link textareaKeyBindings}). */
export const SUBMIT_CHORD: Chord = { key: "return" };
/**
 * Insert a newline instead of submitting. The lone Alt opt-in: it is input editing, not
 * navigation, so the Alt-unreliability trade-off is acceptable (and opentui delivers it as Meta).
 */
export const NEWLINE_CHORD: Chord = { key: "return", alt: true };

// --- remappable app keybindings -------------------------------------------------------------

/**
 * The remappable, app-level keybindings: stable id → default key string. The id is the dispatch
 * target (code references the id, never a key literal); the user remaps the key in their config
 * file under `keybinds[id]`. Structural dialog/config keys (see {@link KEYS}) are intentionally
 * NOT here — only these app-global chords are user-facing enough to remap.
 */
export const KEYBIND_DEFAULTS = {
    "app.command-palette": "ctrl+k",
    "app.toggle-sidebar": "ctrl+b",
    "app.abort": "ctrl+c",
} satisfies Record<string, string>;

/** A remappable keybinding id — a key of {@link KEYBIND_DEFAULTS}. */
export type KeybindId = keyof typeof KEYBIND_DEFAULTS;

// Resolved once: user overrides merged over defaults, each parsed to a chord. Keybinds are
// load-once (a restart applies a config edit) — unlike the live-reactive theme — so resolving on
// first read and caching avoids a disk read (`readConfig`) on every keystroke. An override for an
// unknown id is simply never read; an unparseable value degrades to a non-matching chord.
let resolvedCache: Record<KeybindId, Chord> | null = null;
function resolved(): Record<KeybindId, Chord> {
    if (!resolvedCache) {
        const overrides = readConfig().keybinds ?? {};
        resolvedCache = Object.fromEntries(
            (Object.keys(KEYBIND_DEFAULTS) as KeybindId[]).map((id) => [id, parseChord(overrides[id] ?? KEYBIND_DEFAULTS[id])]),
        ) as Record<KeybindId, Chord>;
    }
    return resolvedCache;
}

/** The resolved chord for a keybinding id (user override over default). */
export function resolveKeybind(id: KeybindId): Chord {
    return resolved()[id];
}

/** The lowercase display label for a keybinding id, e.g. `ctrl+k`. */
export function keybindLabel(id: KeybindId): string {
    return chordLabel(resolveKeybind(id));
}

// --- the mode stack -------------------------------------------------------------------------

/** The base mode: layers tagged with it are live only when no modal is on the stack. */
export const MODE_BASE = "base";
/** The modal mode, pushed while a dialog is open — suspends every `MODE_BASE` layer at once. */
export const MODE_MODAL = "modal";

type ModeEntry = { token: string; mode: string };
const [modeStack, setModeStack] = createSignal<ModeEntry[]>([]);

/** The current mode — the top of the stack, or {@link MODE_BASE} when empty. Reactive. */
export function currentMode(): string {
    return modeStack().at(-1)?.mode ?? MODE_BASE;
}

/**
 * Push a mode and return a disposer that pops exactly this entry (by token, so out-of-order pops
 * from nested modals are safe). Typical use: a `createEffect` pushes on open and `onCleanup`s the
 * disposer, so the mode lifetime tracks the modal's.
 */
export function pushMode(mode: string): () => void {
    const token = randomUUIDv7();
    setModeStack((s) => [...s, { token, mode }]);
    return () => setModeStack((s) => s.filter((e) => e.token !== token));
}

// --- the layer registry & dispatcher --------------------------------------------------------

/** A single bound key within a layer: its {@link Chord}, the action, and whether to swallow it. */
export type BoundBinding = {
    /** The chord this binding matches. */
    chord: Chord;
    /** Run when the chord matches and the layer is active. */
    run: () => void;
    /**
     * When true (the default), the matched key is `preventDefault`'d so a focused textarea/input
     * does not also consume it. Set false for a binding that should fall through to the editor.
     */
    preventDefault?: boolean;
};

/** A declarative layer of bindings, self-gated by `enabled` and/or `mode`. */
export type LayerConfig = {
    /** Inert when false (default true). The gate that replaces `if (someState)`. */
    enabled?: boolean;
    /** Active only when {@link currentMode} equals this. Omit to stay active in every mode. */
    mode?: string;
    /** Conflict resolution across simultaneously-active layers; higher wins (default 0). */
    priority?: number;
    /** The keys this layer binds. */
    bindings: BoundBinding[];
};

// The thunk is stored (not the resolved config) and re-invoked on every keystroke, so reads of
// `enabled`/`mode` inside it are always fresh — that lazy re-evaluation IS the layer's reactivity,
// no effect/memo needed. A plain Map suffices: layers mutate only via mount/cleanup, never mid-
// dispatch. Insertion order is the stable tiebreak for equal-priority layers.
const layers = new Map<string, () => LayerConfig>();

/**
 * Register a reactive layer for the lifetime of the calling component. Call inside component setup
 * (it relies on `onCleanup` to deregister). The `config` thunk is re-read on each keystroke, so it
 * may freely read signals to drive `enabled`/`mode` — this is the declarative replacement for a
 * hand-branched `useKeyboard` handler.
 */
export function useBindings(config: () => LayerConfig): void {
    const token = randomUUIDv7();
    layers.set(token, config);
    onCleanup(() => layers.delete(token));
}

/**
 * Route one keystroke to the winning binding. Collects active layers (`enabled` and `mode` pass),
 * sorts by `priority` (insertion order breaks ties), and runs the first binding whose chord
 * matches. Returns whether the key was handled. Exposed for the root handler and for tests.
 */
export function dispatchKey(ev: KeyLike & { preventDefault: () => void }): boolean {
    const active = [...layers.values()]
        .map((get) => get())
        .filter((c) => (c.enabled ?? true) && (c.mode === undefined || c.mode === currentMode()))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const cfg of active) {
        for (const b of cfg.bindings) {
            if (matchChord(b.chord, ev)) {
                if (b.preventDefault ?? true) ev.preventDefault();
                b.run();
                return true;
            }
        }
    }
    return false;
}

/**
 * Install the single root keyboard handler that drives the engine. Call ONCE per renderer root
 * (the chat `App`, and standalone `ConfigApp`). Every other component declares bindings via
 * {@link useBindings} instead of its own `useKeyboard` — opentui's keyboard is a global,
 * focus-agnostic bus, so one root handler sees every keystroke regardless of focus.
 */
export function useKeymapRoot(): void {
    useKeyboard((key) => {
        dispatchKey(key);
    });
}
