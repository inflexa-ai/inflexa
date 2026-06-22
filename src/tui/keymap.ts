// The single keymap for the TUI. Each logical action maps to its real key `chord` (matched
// structurally, so this module imports NO opentui types) plus a fixed display `label`. Labels
// are platform-neutral and ALWAYS LOWERCASE (`ctrl+k`, `ctrl+b`, `esc`, …) — identical on
// macOS, Linux, and Windows. Lowercase is a fixed project rule for every keybind hint.
//
// Navigation chords use Ctrl, NOT Alt: terminals deliver Alt/Option unreliably — on macOS the
// Option key composes a special character (Option+s → "ß") instead of sending a modifier, so an
// Alt chord may never reach the app. Cmd/⌘ is never used either (terminals don't forward it).
// This is the one source of every keybind hint string shown anywhere in the TUI.

/** A platform-neutral key chord, matched structurally against opentui's parsed key. */
export type Chord = {
    /** opentui key `name` (lowercase), e.g. `"k"`, `"b"`, `"c"`, `"return"`. */
    key: string;
    /** Requires the Control modifier when true. */
    ctrl?: boolean;
    /** Requires the Option/Alt modifier when true (delivered as Meta in most terminals). */
    alt?: boolean;
};

/** A bound action: its real {@link Chord} plus the lowercase display label shown to the user. */
export type Binding = {
    /** The real chord the handler matches. */
    chord: Chord;
    /** Lowercase display label, e.g. `ctrl+k` — the same on every platform. */
    label: string;
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

/**
 * Every TUI keybinding. Chat actions drive `app.tsx`'s `useKeyboard`; `submit`/`newline` are the
 * textarea's own opentui key-bindings; config actions are label-only (their matching lives in
 * `config.tsx`, which shares the status bar and reads its hint labels from here).
 */
export const KEYMAP = {
    openPalette: { chord: { key: "k", ctrl: true }, label: "ctrl+k" },
    toggleSidebar: { chord: { key: "b", ctrl: true }, label: "ctrl+b" },
    abort: { chord: { key: "c", ctrl: true }, label: "ctrl+c" },
    // newline/submit are matched by the textarea's own opentui keyBindings, not useKeyboard.
    // newline is the lone Alt opt-in: it is input editing, not navigation, so the
    // Alt-unreliability trade-off is acceptable here.
    newline: { chord: { key: "return", alt: true }, label: "alt+enter" },
    submit: { chord: { key: "return" }, label: "enter" },
    // Config-screen keys: their labels render here, but `config.tsx` matches the keys itself.
    save: { chord: { key: "s" }, label: "s" },
    exit: { chord: { key: "escape" }, label: "esc" },
    moveSelection: { chord: { key: "up" }, label: "↑/↓" },
    changeOption: { chord: { key: "left" }, label: "←/→" },
} satisfies Record<string, Binding>;
