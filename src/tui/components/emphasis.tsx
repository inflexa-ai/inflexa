import type { JSX } from "solid-js";

import { theme } from "../theme.ts";
import type { ThemeColors } from "../../lib/design_system.ts";

/*
 * The design system's "Type & emphasis" scale as composable inline JSX, so call sites read
 * `<Fg role="tool"><Bold>read_file</Bold></Fg>` instead of hand-composing opentui's
 * `t``…${fg(theme().tool)(bold("read_file"))}…``` templates. All six live in ONE file (a scoped
 * exception to the "one component per file" rule): each is a trivial wrapper of the SAME concept —
 * one inline span — and they are always reached for together as a set, so splitting them into six
 * micro-files would scatter a single vocabulary.
 *
 * All emit inline text nodes (spans), so they nest freely inside a `<text>` and beside each other
 * WITHOUT the "TextNodeRenderable only accepts strings…" crash you get from nesting a block
 * `<text>` in a `<text>`.
 */

/** Bold — names, active items. */
export function Bold(props: { children: JSX.Element }): JSX.Element {
    return <b>{props.children}</b>;
}

/**
 * Italic — reasoning / quoted. The ITALIC bit is always emitted, but many terminals (macOS
 * Terminal.app, common `tmux` setups) drop it and show plain text, so ALWAYS wrap in a muted
 * `<Fg>` too (`<Fg role="fgMuted"><Italic>…</Italic></Fg>`) so the meaning survives.
 */
export function Italic(props: { children: JSX.Element }): JSX.Element {
    return <i>{props.children}</i>;
}

/** Underline — links / paths. */
export function Underline(props: { children: JSX.Element }): JSX.Element {
    return <u>{props.children}</u>;
}

/*
 * Dim/Reverse/Fg reach for the `style` prop because opentui-solid's reconciler applies fg/bg/
 * attributes to a text node ONLY through `style` (its setProperty does
 * `node.attributes |= createTextAttributes(value); node.fg = …; node.bg = …` for the `style` case
 * and ignores top-level fg/bg/attributes on spans). `createTextAttributes` reads the BOOLEAN keys
 * `{ dim, inverse, italic, … }`.
 *
 * eslint-disable solid/style-prop -- `style` here is opentui's TextNode style object (fg/bg +
 * attribute booleans), NOT a CSS style map; it is the only sanctioned channel for span styling, so
 * the CSS-oriented `solid/style-prop` rule is a false positive throughout this file.
 */
/* eslint-disable solid/style-prop */

/** Dim — meta. The terminal DIM attribute renders unreliably; prefer `<Fg role="fgMuted">`. */
export function Dim(props: { children: JSX.Element }): JSX.Element {
    return <span style={{ dim: true }}>{props.children}</span>;
}

/**
 * Reverse — selection / cursor row. An EXPLICIT fg/bg swap (dark text on a light bar), NOT the
 * `{ inverse: true }` attribute: opentui bakes the INVERSE swap into the cell at render, and with
 * the span's `bg` unset the swap collapses fg and bg to the same color — a solid invisible block.
 * Painting both colors ourselves is the only reliably-visible inverse (and is also why the dead
 * `@opentui/core` `reverse()` helper, which only ever sets a bit, can't be used). Reads `theme()`
 * so it recolors live; the inner content (e.g. a nested `<Bold>`) inherits this fg/bg.
 */
export function Reverse(props: { children: JSX.Element }): JSX.Element {
    return <span style={{ fg: theme().bg, bg: theme().fg }}>{props.children}</span>;
}

/** Fg — paint the foreground with a theme color role (never a hex). The one way to color inline. */
export function Fg(props: { role: keyof ThemeColors; children: JSX.Element }): JSX.Element {
    return <span style={{ fg: theme()[props.role] }}>{props.children}</span>;
}
