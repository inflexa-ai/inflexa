// The TUI keybinding engine: bindings are DATA, dispatched by a central router — never
// hand-written `if (key.name === "x" && state === y)`. Each feature *declares* a layer of
// bindings via `useBindings`, self-gated by a reactive `enabled` flag, a `mode`, and/or a focus
// `target`; the single root `useKeyboard` handler (`useKeymapRoot`) collects the active layers and
// routes each keystroke to the winning binding. Opening a modal pushes a `mode` so the whole
// base-UI keymap goes inert at once, with no per-binding `if (dialogOpen)` anywhere.
//
// A complete port of OpenCode's `@opentui/keymap` (not a dependency here), at the right altitude:
//   - declarative layers with `enabled` / `mode` / `target` / `priority` / `fallthrough`
//   - a mode stack for modal capture
//   - a timed LEADER key + multi-stroke chord SEQUENCES (`<leader>n`), with escape-abort and
//     backspace-pop of a half-typed chord, and comma-alternatives in key strings
//   - reactive pending-sequence state (`leaderActive` / `pendingSequence` / `reachableKeys`) that
//     drives the which-key panel — free documentation, since bindings carry `desc`/`group`
//   - config-file remapping of the app-level keys (command id → key string)
//
// Chords are matched STRUCTURALLY against opentui's parsed key (so the matching core is
// opentui-type-free); only the root handler + focus-target check touch opentui. Display labels are
// DERIVED from the chord (`chordLabel`) — one source, never a hand-kept label/chord pair that can
// drift. Labels are ALWAYS LOWERCASE (`ctrl+k`, `esc`) and platform-neutral. Navigation chords use
// Ctrl, NOT Alt (terminals deliver Alt/Option unreliably) and never Cmd (not forwarded).

import { randomUUIDv7 } from "bun";
import { createSignal, onCleanup } from "solid-js";
import { useKeyboard, useRenderer } from "@opentui/solid";
import type { Renderable } from "@opentui/core";

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

/** An ordered run of {@link Chord} strokes — a single key (length 1) or a multi-stroke sequence. */
export type Sequence = Chord[];

/** The minimal shape of opentui's parsed key that the matcher reads. */
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

/** The opentui key event the root handler receives: a {@link KeyLike} plus dispatch controls. */
type KeyEventLike = KeyLike & {
    /** Swallow the key so a focused textarea/input does not also consume it. */
    preventDefault: () => void;
    /** `"release"` events are ignored — only presses/repeats drive bindings. */
    eventType?: "press" | "repeat" | "release";
};

// --- chord comparison -----------------------------------------------------------------------

/** The {@link Chord} a key event represents (Alt folded from either option or meta). */
function eventChord(ev: KeyLike): Chord {
    return { key: ev.name, ctrl: ev.ctrl, alt: ev.option || ev.meta };
}

/** Structural equality of two chords, treating an absent modifier as false. */
function chordEq(a: Chord, b: Chord): boolean {
    return a.key === b.key && (a.ctrl ?? false) === (b.ctrl ?? false) && (a.alt ?? false) === (b.alt ?? false);
}

/**
 * True when `ev` is the `chord`. Option/Alt is accepted from EITHER `option` or `meta` (terminals
 * deliver it inconsistently). Modifiers not required by the chord must be absent.
 */
export function matchChord(chord: Chord, ev: KeyLike): boolean {
    return chordEq(chord, eventChord(ev));
}

/** True when `prefix` is a (non-strict) leading run of `seq`. */
function isPrefix(prefix: Sequence, seq: Sequence): boolean {
    if (prefix.length > seq.length) return false;
    return prefix.every((c, i) => chordEq(c, seq[i]!));
}

/** True when `prefix` is a STRICTLY shorter leading run of `seq` (a longer sequence is reachable). */
function isStrictPrefix(prefix: Sequence, seq: Sequence): boolean {
    return prefix.length < seq.length && isPrefix(prefix, seq);
}

/** Sequence equality. */
function seqEq(a: Sequence, b: Sequence): boolean {
    return a.length === b.length && isPrefix(a, b);
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
// so the glyph set is the single source — never inline a literal); everything else shows its
// friendly name. Keys absent here display verbatim (`k`, `b`, …).
const KEY_LABEL: Record<string, string> = {
    return: "enter",
    escape: "esc",
    up: GLYPHS.arrowUp,
    down: GLYPHS.arrowDown,
    left: GLYPHS.arrowLeft,
    right: GLYPHS.arrowRight,
    space: "space",
};

const LEADER_TOKEN = "<leader>";

/**
 * Parse a single chord (`"ctrl+k"`, `"enter"`, `"alt+enter"`) into a {@link Chord}. Best-effort and
 * total: an unparsable string yields a chord whose `key` never matches a real keystroke, which
 * disables that binding rather than throwing. `opt`/`option` are accepted as aliases for `alt`.
 */
export function parseChord(s: string): Chord {
    const parts = s.toLowerCase().trim().split("+");
    const key = parts.pop() ?? "";
    return {
        key: CANON[key] ?? key,
        ctrl: parts.includes("ctrl"),
        alt: parts.includes("alt") || parts.includes("opt") || parts.includes("option"),
    };
}

/**
 * Parse a key SPEC into the alternative sequences it denotes. The full grammar, expressed as data:
 *   - comma = alternatives: `"ctrl+c,ctrl+d"` → two single-stroke sequences for the same action
 *   - `<leader>` expands to the resolved `leader` chord as the first stroke: `"<leader>n"`
 *   - space = a multi-stroke sequence: `"<leader>g g"` → leader, then g, then g
 *   - `+` = modifiers within one stroke
 */
export function parseKeySpec(spec: string, leader: Chord): Sequence[] {
    return spec
        .split(",")
        .map((alt) => parseSequence(alt.trim(), leader))
        .filter((seq) => seq.length > 0);
}

function parseSequence(s: string, leader: Chord): Sequence {
    if (s.startsWith(LEADER_TOKEN)) {
        const rest = s.slice(LEADER_TOKEN.length).trim();
        return rest ? [leader, ...rest.split(/\s+/).map(parseChord)] : [leader];
    }
    return s.split(/\s+/).filter(Boolean).map(parseChord);
}

/** The lowercase, platform-neutral display label for a single chord, e.g. `ctrl+k`, `alt+enter`, `↑`. */
export function chordLabel(chord: Chord): string {
    const parts: string[] = [];
    if (chord.ctrl) parts.push("ctrl");
    if (chord.alt) parts.push("alt");
    parts.push(KEY_LABEL[chord.key] ?? chord.key);
    return parts.join("+");
}

/** The display label for a whole sequence, strokes space-separated (e.g. `ctrl+x n`). */
export function sequenceLabel(seq: Sequence): string {
    return seq.map(chordLabel).join(" ");
}

// --- canonical structural chords ------------------------------------------------------------

/**
 * Canonical chords for structural navigation shared across dialogs/config (cursor moves, submit,
 * cancel). Deliberately NOT remappable — conventional and not worth a config surface (the report's
 * inline-`cmd` split: behavior that should not be remapped). Reference these instead of writing
 * `{ key: "up" }` at each site, so the chord — and its derived label — has one source.
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

/** Submit the chat message (textarea-level; see input_bar's `keyBindings`). */
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
 * under `keybinds[id]`. Structural dialog/config keys (see {@link KEYS}) are intentionally absent —
 * only these app-global chords are user-facing enough to remap. `app.leader` seeds every
 * `<leader>` sequence.
 */
export const KEYBIND_DEFAULTS = {
    "app.command-palette": "ctrl+k",
    "app.toggle-sidebar": "ctrl+b",
    "app.abort": "ctrl+c",
    "app.clear-input": "ctrl+u",
    "app.leader": "ctrl+x",
} satisfies Record<string, string>;

/** A remappable keybinding id — a key of {@link KEYBIND_DEFAULTS}. */
export type KeybindId = keyof typeof KEYBIND_DEFAULTS;

// Resolved once: user overrides merged over defaults, each parsed to a chord. Keybinds are
// load-once (a restart applies a config edit) — unlike the live-reactive theme — so resolving on
// first read and caching avoids a disk read (`readConfig`) on every keystroke. An override for an
// unknown id is never read; an unparsable value degrades to a non-matching chord. resolveKeybind
// takes the FIRST alternative only (the app keys are single-stroke); sequences come via parseKeySpec.
let resolvedCache: Record<KeybindId, Chord> | null = null;
let leaderTimeoutCache: number | null = null;
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

/** The resolved leader chord — the first stroke of every `<leader>` sequence. */
export function leaderChord(): Chord {
    return resolveKeybind("app.leader");
}

/** Build a leader-prefixed sequence, e.g. `leaderSeq("n")` → `[leader, n]`. */
export function leaderSeq(suffix: string): Sequence {
    return [leaderChord(), parseChord(suffix)];
}

// How long a half-typed sequence stays pending before it is abandoned (config, load-once).
function leaderTimeoutMs(): number {
    if (leaderTimeoutCache == null) leaderTimeoutCache = readConfig().leaderTimeout ?? 2000;
    return leaderTimeoutCache;
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

// --- focus targets --------------------------------------------------------------------------

// The renderer whose focus state gates `target` layers. Captured by useKeymapRoot (one root per
// renderer) and read at dispatch — a plain var, since there is exactly one live renderer.
let activeRenderer: ReturnType<typeof useRenderer> | null = null;

/** True when `focused` is `target` itself or a descendant of it (the fine-grained focus filter). */
export function isFocusedWithin(target: Renderable, focused: Renderable | null): boolean {
    if (!focused) return false;
    if (focused === target) return true;
    return target.findDescendantById(focused.id) !== undefined;
}

// --- the layer registry & dispatcher --------------------------------------------------------

/** A single bound key/sequence within a layer. */
export type BoundBinding = {
    /** A single stroke ({@link Chord}) or a multi-stroke {@link Sequence}. */
    chord: Chord | Sequence;
    /** Run when the chord/sequence matches and the layer is active. */
    run: () => void;
    /** which-key label + footer text for this binding (the "what does this key do" prose). */
    desc?: string;
    /** which-key grouping header. */
    group?: string;
    /**
     * When true (the default), the matched key is `preventDefault`'d so a focused textarea/input
     * does not also consume it. Set false for a binding that should fall through to the editor.
     */
    preventDefault?: boolean;
    /** When true, lower-priority layers keep being considered after this binding runs. */
    fallthrough?: boolean;
};

/** A declarative layer of bindings, self-gated by `enabled`, `mode`, and/or focus `target`. */
export type LayerConfig = {
    /** Inert when false (default true). The gate that replaces `if (someState)`. */
    enabled?: boolean;
    /** Active only when {@link currentMode} equals this. Omit to stay active in every mode. */
    mode?: string;
    /** Active only when this renderable (or a descendant) is focused. The complement to `mode`. */
    target?: Renderable | null;
    /** Conflict resolution across simultaneously-active layers; higher wins (default 0). */
    priority?: number;
    /** The keys/sequences this layer binds. */
    bindings: BoundBinding[];
};

// The thunk is stored (not the resolved config) and re-invoked on every keystroke, so reads of
// `enabled`/`mode`/`target` inside it are always fresh — that lazy re-evaluation IS the layer's
// reactivity, no effect/memo needed. A plain Map suffices: layers mutate only via mount/cleanup.
// Insertion order is the stable tiebreak for equal-priority layers.
const layers = new Map<string, () => LayerConfig>();

/** The normalized stroke sequence of a binding (a single chord becomes a length-1 sequence). */
function seqOf(b: BoundBinding): Sequence {
    return Array.isArray(b.chord) ? b.chord : [b.chord];
}

/**
 * Register a reactive layer for the lifetime of the calling component. Call inside component setup
 * (it relies on `onCleanup` to deregister). The `config` thunk is re-read on each keystroke, so it
 * may freely read signals to drive `enabled`/`mode`/`target` — the declarative replacement for a
 * hand-branched `useKeyboard` handler.
 */
export function useBindings(config: () => LayerConfig): void {
    const token = randomUUIDv7();
    layers.set(token, config);
    onCleanup(() => layers.delete(token));
}

/** Active layers (enabled + mode + focus-target pass), highest priority first. */
function activeLayers(): LayerConfig[] {
    const focused = activeRenderer?.currentFocusedRenderable ?? null;
    return [...layers.values()]
        .map((get) => get())
        .filter((c) => (c.enabled ?? true) && (c.mode === undefined || c.mode === currentMode()) && (c.target == null || isFocusedWithin(c.target, focused)))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

// --- pending-sequence state machine ---------------------------------------------------------

const [pending, setPending] = createSignal<Sequence>([]);
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clearPending(): void {
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
    }
    setPending([]);
}

function armTimer(): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
        pendingTimer = null;
        setPending([]);
    }, leaderTimeoutMs());
    // Don't let a half-typed chord keep the process alive (matters for tests + clean shutdown).
    pendingTimer.unref?.();
}

function popPending(): void {
    const next = pending().slice(0, -1);
    if (next.length === 0) clearPending();
    else {
        setPending(next);
        armTimer();
    }
}

/**
 * Apply `seq` against the active layers: run every full match (stopping at the first non-fallthrough
 * one), else report whether a longer sequence is still reachable.
 */
function tryDispatch(seq: Sequence, ev: KeyEventLike): "handled" | "pending" | "none" {
    const active = activeLayers();
    let handled = false;
    for (const layer of active) {
        for (const b of layer.bindings) {
            if (seqEq(seqOf(b), seq)) {
                if (b.preventDefault ?? true) ev.preventDefault();
                b.run();
                handled = true;
                if (!b.fallthrough) return "handled";
            }
        }
    }
    if (handled) return "handled";
    const reachable = active.some((l) => l.bindings.some((b) => isStrictPrefix(seq, seqOf(b))));
    return reachable ? "pending" : "none";
}

/**
 * Route one keystroke through the engine. Honors a pending multi-stroke sequence (escape aborts it,
 * backspace pops a stroke), runs a full match, or holds the key as a new pending prefix. Returns
 * whether the key was handled. Exposed for the root handler and for tests.
 */
export function dispatchKey(ev: KeyEventLike): boolean {
    if (ev.eventType === "release") return false;
    const k = eventChord(ev);
    const wasPending = pending().length > 0;

    // While a sequence is pending, escape abandons it and backspace pops the last stroke.
    if (wasPending) {
        if (chordEq(KEYS.escape, k)) {
            clearPending();
            ev.preventDefault();
            return true;
        }
        if (k.key === "backspace") {
            popPending();
            ev.preventDefault();
            return true;
        }
    }

    const seq: Sequence = [...pending(), k];
    const result = tryDispatch(seq, ev);
    if (result === "handled") {
        clearPending();
        return true;
    }
    if (result === "pending") {
        setPending(seq);
        armTimer();
        ev.preventDefault();
        return true;
    }

    // No match. If a sequence was pending, this key broke it: abandon and retry the key alone, so a
    // stray key after the leader still triggers its own binding (or starts a new sequence).
    if (wasPending) {
        clearPending();
        const retry = tryDispatch([k], ev);
        if (retry === "handled") return true;
        if (retry === "pending") {
            setPending([k]);
            armTimer();
            ev.preventDefault();
            return true;
        }
    }
    return false;
}

// --- which-key reactive selectors -----------------------------------------------------------

/** The strokes typed so far in an in-progress sequence (empty when none). Reactive. */
export function pendingSequence(): Sequence {
    return pending();
}

/** True while a multi-stroke sequence is half-typed — drives the which-key panel. Reactive. */
export function leaderActive(): boolean {
    return pending().length > 0;
}

/** One reachable next-stroke from the current pending prefix, with its which-key metadata. */
export type NextKey = {
    /** The next stroke's display label (e.g. `n`, `↑`). */
    stroke: string;
    /** What the (completed) binding does. */
    desc: string;
    /** Grouping header. */
    group: string;
    /** True when this stroke leads deeper into a longer sequence rather than completing one. */
    continues: boolean;
};

/**
 * Every next stroke reachable from the current pending prefix, deduped, for the which-key panel.
 * Reactive on the pending signal, so the panel refreshes as the user types into a sequence. Returns
 * `[]` when nothing is pending. This is *free* documentation — the labels come from each binding's
 * `desc`/`group`, no separate table.
 */
export function reachableKeys(): NextKey[] {
    const prefix = pending();
    if (prefix.length === 0) return [];
    const out: NextKey[] = [];
    const seen = new Set<string>();
    for (const layer of activeLayers()) {
        for (const b of layer.bindings) {
            const seq = seqOf(b);
            if (!isStrictPrefix(prefix, seq)) continue;
            const next = seq[prefix.length]!;
            const stroke = chordLabel(next);
            const dedupe = `${stroke}|${b.desc ?? ""}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            out.push({ stroke, desc: b.desc ?? "", group: b.group ?? "", continues: seq.length > prefix.length + 1 });
        }
    }
    return out;
}

// --- root install ---------------------------------------------------------------------------

/**
 * Install the single root keyboard handler that drives the engine, and capture the renderer for
 * focus-`target` gating. Call ONCE per renderer root (the chat `App`, and standalone `ConfigApp`).
 * Every other component declares bindings via {@link useBindings} instead of its own `useKeyboard` —
 * opentui's keyboard is a global, focus-agnostic bus, so one root handler sees every keystroke.
 */
export function useKeymapRoot(): void {
    activeRenderer = useRenderer();
    onCleanup(() => {
        activeRenderer = null;
        clearPending();
    });
    useKeyboard((key) => {
        dispatchKey(key);
    });
}
