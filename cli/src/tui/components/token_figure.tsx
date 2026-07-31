import { createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";

import { GLYPHS } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import { NOT_REPORTED, formatTokenFigure, tokenFigureDetail } from "../../lib/usage_format.ts";
import type { TokenFigureArm, TokenQuantities } from "../../lib/usage_format.ts";
import { theme } from "../theme.ts";
import { Bold, Fg } from "./emphasis.tsx";

/**
 * Which of the two written forms defined by the `usage-figure-rendering` capability an instance
 * renders. The names are the ones the capability uses, so a surface's spec sentence ("this section
 * uses the labelled form") and its call site read as the same statement.
 */
export type TokenFigureVariant =
    /** `↑820.3k ↓43.3k` on one line — for a figure DECORATING a row whose subject is something else. */
    | "short"
    /** `820.3k in` / `43.3k out` at opposite edges, breakdowns nested — for a figure that IS the subject. */
    | "long";

/** Two spaces — the one indent step every nested quantity and every decorating figure sits at. */
const INDENT = "  ";

/**
 * One arm of the long form: the labelled headline with the quantities that are PARTS of it stacked
 * beneath, indented.
 *
 * A column rather than a row, and the parts indented, because that nesting is the ONLY thing stating
 * "these are parts of the figure above" — levelled onto one line they read as peers a reader may add,
 * which for a cached prefix already counted inside the input total is exactly the wrong sum.
 *
 * `lead` is what puts the two arms at opposite EDGES rather than at the head of one half each. The
 * leading arm grows into all the slack, so the trailing arm — sized to its own content and explicitly
 * unshrinkable, since an unsized box defaults to `flexShrink: 1` and would otherwise be squeezed by
 * the row — is pushed flush against the trailing edge. Two `flexGrow={1}` halves were the defect this
 * replaces: each arm owned half the width and left-aligned inside it, so the output figure floated
 * mid-panel adjacent to nothing.
 *
 * Both arms keep their contents LEFT-aligned, which is deliberate and is what the trailing arm's
 * alignment must not undo: a right-aligned column would flush its nested quantities against the edge
 * too, collapsing the indent that states they are parts of the arm above. The accepted cost is that
 * the trailing arm is as wide as its widest LINE, so an arm whose nested quantity is longer than its
 * figure (`reasoning 9.1k` against `42.4k out`) carries that figure a few cells in from the edge — the
 * arm is still flush, and the indent still reads as an indent.
 *
 * An arm the provider never reported renders the absent word rather than vanishing: the column still
 * exists (input is always leading, output always trailing), it simply has nothing to report, and a
 * reader scanning for the output figure must find that absence where the figure would have been.
 */
function LongArm(props: { arm: TokenFigureArm | null; bold?: boolean; role: keyof ThemeColors; lead?: boolean }): JSX.Element {
    return (
        <box flexDirection="column" flexGrow={props.lead ? 1 : 0} flexShrink={props.lead ? 1 : 0}>
            <Show when={props.arm} keyed fallback={<text fg={theme().fgMuted}>{NOT_REPORTED}</text>}>
                {(arm: TokenFigureArm) => (
                    <text>
                        <Show when={props.bold} fallback={<Fg role={props.role}>{arm.labelled}</Fg>}>
                            <Fg role={props.role}>
                                <Bold>{arm.labelled}</Bold>
                            </Fg>
                        </Show>
                    </text>
                )}
            </Show>
            <For each={props.arm?.breakdown ?? []}>
                {(part) => (
                    <text>
                        <Fg role="fgMuted">{`${INDENT}${part.label} `}</Fg>
                        <Fg role={props.role}>{part.value}</Fg>
                    </text>
                )}
            </For>
        </box>
    );
}

/** Props for {@link TokenFigure}. */
export type TokenFigureProps = {
    /** What to write. Absence per quantity is preserved all the way through — see {@link TokenQuantities}. */
    quantities: TokenQuantities;
    /**
     * Which written form. A property of the SURFACE, stated in that surface's own capability spec —
     * never a per-call aesthetic choice, which is how eight surfaces come to render one notation eight
     * ways.
     */
    variant: TokenFigureVariant;
    /** Indent the figure one step under the row it belongs to. `short` only; the long form owns its own box. */
    indent?: boolean;
    /** Bold the headline quantities. `long` only — a dialog headline is emphasised, a rail section is not. */
    bold?: boolean;
    /** Tone for the reported quantities; the nested parts' labels are always muted. Defaults to `fg`. */
    role?: keyof ThemeColors;
};

/**
 * A recorded token figure, in whichever of the product's two written forms the surface takes.
 *
 * The ONE place a figure becomes pixels. Both forms are built by `lib/usage_format.ts` from the same
 * quantities — so they can never disagree about a VALUE, only about presentation — and this component
 * is the matching single owner of the presentation: the tone ladder (reported quantities data-toned,
 * an absence muted), the nesting of the cache and reasoning counts under the arm they are part of, and
 * the leading/trailing placement of the two arms. A surface that laid out its own arms would be free
 * to level the nesting, which is the one layout mistake this notation exists to prevent.
 *
 * NOTHING is rendered when neither headline quantity was reported and the variant is `long`; the
 * `short` variant renders a muted em dash instead, because it sits under a row that is still there and
 * an absent line would silently shorten a list its reader is scanning down. Neither ever renders a
 * zero: a zero asserts a measurement, and absence here means no provider ever reported one.
 */
export function TokenFigure(props: TokenFigureProps): JSX.Element {
    const role = (): keyof ThemeColors => props.role ?? "fg";
    // One call for both arms: `tokenFigureDetail` is the single place a quantity is turned into a
    // written value, and reading it once per render keeps that literally true rather than nearly so.
    const detail = createMemo(() => tokenFigureDetail(props.quantities));

    return (
        <Show when={props.variant === "long"} fallback={<ShortFigure quantities={props.quantities} prefix={props.indent ? INDENT : ""} role={role()} />}>
            {/* `width="100%"` so the row spans its parent and the trailing arm has slack to be pushed
                across; `flexShrink={0}` because a `<text>` has a non-numeric size and therefore defaults
                to shrinkable, and a `flexGrow` scroll region beside this one squeezes every such row to
                zero height on a short panel — painting the figure lines on top of each other. */}
            <box flexDirection="row" width="100%" flexShrink={0}>
                <LongArm arm={detail().input} bold={props.bold} role={role()} lead />
                <LongArm arm={detail().output} bold={props.bold} role={role()} />
            </box>
        </Show>
    );
}

/**
 * The short form on its own line: the compact figure, or a muted em dash when the calls behind it
 * reported no quantity at all.
 *
 * The em dash is the rail's existing absence vocabulary (the same glyph it prints for a time it does
 * not have), chosen over an omitted line so a run row's second line does not appear and disappear
 * depending on what its provider happened to report.
 */
function ShortFigure(props: { quantities: TokenQuantities; prefix: string; role: keyof ThemeColors }): JSX.Element {
    const figure = (): string => formatTokenFigure(props.quantities);
    return (
        <Show
            when={figure()}
            keyed
            fallback={
                <text>
                    <Fg role="fgMuted">{`${props.prefix}${GLYPHS.emDash}`}</Fg>
                </text>
            }
        >
            {(text: string) => (
                <text>
                    <Fg role={props.role}>{`${props.prefix}${text}`}</Fg>
                </text>
            )}
        </Show>
    );
}
