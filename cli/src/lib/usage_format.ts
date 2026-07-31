import { GLYPHS } from "./design_system.ts";

/**
 * Rendered in place of any quantity the provider never reported. Deliberately a WORD, not a dash and
 * never a `0`: the ledger's central discipline is that an absent figure is an unknown rather than a
 * measurement, and a surface that renders it as zero erases exactly the distinction the nullable
 * columns exist to preserve. One spelling in the text report, in every table, and on every TUI
 * surface, so a reader never has to learn two vocabularies for the same fact.
 *
 * It lives beside the two written forms rather than inside either producer because it is part of the
 * NOTATION — the answer to "what does an absent quantity render as" — and the notation has two
 * consumers (`inflexa usage` and the TUI) that must not be able to spell it differently. What is
 * shared is the vocabulary, not the composition: a surface paints label and figure in different theme
 * roles, which a pre-joined line cannot express.
 */
export const NOT_REPORTED = "not reported";

/**
 * The five quantities a token figure can be built from — every one optional, because absence here
 * means "no provider ever reported this" and is a fact the ledger deliberately preserves all the way
 * down from `SUM()` returning NULL for an all-absent group. A formatter that flattened absence to `0`
 * would destroy the distinction every layer beneath it kept.
 *
 * Declared structurally rather than imported. `lib/` is non-domain infrastructure, so importing the
 * db layer's `LlmUsageTotals` or `modules/harness`'s `TurnUsage` would invert the infra→feature
 * direction AND bind one notation to one of its two producers. Both of those types satisfy this
 * shape, so both pass their own value through unconverted, and so does anything else that grows the
 * same counts (extra properties like the ledger's `calls` are ignored — this is the minimum a figure
 * needs, not a claim about what the caller holds).
 *
 * Nothing here is ever added together. The two cache counts are parts OF `inputTokens` and
 * `reasoningTokens` is reported alongside `outputTokens`, so any sum double-counts a cached prefix
 * and yields a number whose meaning shifts with each provider's cache reporting.
 */
export type TokenQuantities = {
    /** Total billed prompt tokens, cache reads included — the up arm. */
    readonly inputTokens?: number;
    /** Total completion tokens — the down arm. */
    readonly outputTokens?: number;
    /** Prefix tokens written into the provider's prompt cache; a part of {@link TokenQuantities.inputTokens}. */
    readonly cacheCreationInputTokens?: number;
    /** Prefix tokens served from the provider's prompt cache; a part of {@link TokenQuantities.inputTokens}. */
    readonly cacheReadInputTokens?: number;
    /** Reasoning tokens exactly as the provider reported them; a detail of {@link TokenQuantities.outputTokens}. */
    readonly reasoningTokens?: number;
};

/**
 * One quantity that is a PART of the arm it hangs under, never an arm itself — which is why it
 * carries no arrow. The arrows mark the two directions a figure is read in (what went up, what came
 * back down); a breakdown has no direction of its own, it is a slice of one that does.
 */
export type TokenFigureBreakdown = {
    /** What the slice is, in the one vocabulary every surface prints — `cache write`, `cache read`, `reasoning`. */
    readonly label: string;
    /** The quantity through `Number.formatTokens`, with no arrow prefix. */
    readonly value: string;
};

/**
 * One arm of a detailed figure: the headline quantity in BOTH written forms, plus the breakdowns
 * that are parts of it.
 *
 * The two writings ride on one object rather than coming from two functions because that is what
 * makes them unable to disagree: there is one `formatTokens()` call per arm, and the forms differ
 * only in what is glued to its result. A surface picks the writing its own capability spec names —
 * see {@link formatTokenFigure} and {@link formatTokenFigureLabelled} for which is which and why.
 *
 * The breakdowns live INSIDE the arm rather than in a flat list beside it, and that is the point of
 * the shape: nesting is what tells a reader the cache counts are already inside the input total, and
 * a caller can only level them by deliberately flattening this structure. A sibling list would make
 * levelling the path of least resistance, which is exactly the layout that invites a reader to add a
 * cached prefix to a total it is already in.
 */
export type TokenFigureArm = {
    /**
     * The arm as {@link formatTokenFigure} writes it — `↑767.6k`. Character-identical to that arm of
     * the compact form on purpose: the detailed and compact renderings of one set of quantities must
     * be recognisable as the same figure, not two dialects of it.
     */
    readonly compact: string;
    /**
     * The arm as {@link formatTokenFigureLabelled} writes it — `767.6k in`. Same relationship to the
     * labelled form that {@link TokenFigureArm.compact} has to the compact one, and it exists at ARM
     * granularity because the two labelled surfaces both nest breakdowns: nesting needs a position
     * per arm (the rail stacks them, the dialog runs them edge to edge), which a pre-joined one-line
     * string cannot give them.
     */
    readonly labelled: string;
    /** Breakdowns of THIS arm, in the order they are declared below; empty when none was reported. */
    readonly breakdown: readonly TokenFigureBreakdown[];
};

/**
 * A figure for a surface with room to show the breakdowns — the sidebar rail, a dialog headline.
 *
 * Returned as structure rather than one joined string because the callers are an opentui rail and a
 * dialog that colour the parts independently (a headline is data-toned, a breakdown is muted) and
 * place them differently (the rail stacks, the dialog runs input-left / output-right). A pre-joined
 * string would force both to re-split what this module just composed.
 *
 * An arm is `null` when its headline quantity was never reported, so BOTH arms null is the
 * distinguishable "nothing was reported" state — the same condition under which
 * {@link formatTokenFigure} and {@link formatTokenFigureLabelled} both return `""`, by
 * construction. A caller seeing it renders a muted absence, never a zero.
 */
export type TokenFigureDetail = {
    /** The up arm and the cache counts nested under it, or `null` when no input quantity was reported. */
    readonly input: TokenFigureArm | null;
    /** The down arm and the reasoning count nested under it, or `null` when no output quantity was reported. */
    readonly output: TokenFigureArm | null;
};

/**
 * Build one arm in both written forms, dropping every breakdown whose quantity is absent.
 *
 * `formatTokens()` is called exactly ONCE per arm and both writings are glued onto that one result,
 * which is the mechanism behind "the two forms can never disagree about a value, only about
 * presentation" — there is no second rounding, no second unit choice, and no second place to forget
 * a quantity.
 *
 * A breakdown whose headline is absent is dropped WITH the arm rather than promoted to a line of its
 * own: nesting is the only thing that states "this is a part of that", so a slice with no parent to
 * sit under could only render as a sibling of input and output — precisely the levelling this
 * notation exists to prevent. The pathological case it covers (a group whose rows reported cache
 * reads but never an input total) stays fully readable in `inflexa usage`, which is the audit
 * surface; a figure is a summary and is allowed to omit what it cannot state honestly.
 */
function armOf(arrow: string, word: string, headline: number | undefined, parts: readonly (readonly [string, number | undefined])[]): TokenFigureArm | null {
    if (headline === undefined) return null;
    const value = headline.formatTokens();
    return {
        compact: `${arrow}${value}`,
        labelled: `${value} ${word}`,
        breakdown: parts.flatMap(([label, v]) => (v === undefined ? [] : [{ label, value: v.formatTokens() }])),
    };
}

/**
 * The arms a figure actually has, in reading order, with an absent one dropped.
 *
 * Both one-line forms are joins over THIS list, and it is produced by {@link tokenFigureDetail} — so
 * a quantity omitted from one form is omitted from all three renderings by construction rather than
 * by three call sites agreeing to apply the same rule. The breakdown arrays a one-line form never
 * reads are built anyway; that allocation is worth more than a second absence rule to keep in step.
 */
function armsOf(q: TokenQuantities): readonly TokenFigureArm[] {
    const detail = tokenFigureDetail(q);
    return [detail.input, detail.output].filter((arm): arm is TokenFigureArm => arm !== null);
}

/**
 * The COMPACT written form of a token figure: `↑767.6k ↓33.1k`.
 *
 * For a figure that DECORATES a row whose subject is something else — a message header, a run or
 * step row, a picker row, a grouping row in the usage dialog. Such a figure is scanned in passing
 * beside the thing it annotates, so it must not crowd it; that is the whole reason two forms exist
 * rather than one. Where the figure IS the subject, reach for {@link formatTokenFigureLabelled}.
 *
 * The arrows are read from the READER's seat — you send up, you get back down — and come from the
 * shared glyph registry, never inlined here or at a call site. A positional `767.6k/33.1k` was
 * rejected because a half figure is a normal state (absence means not-reported) and a missing side
 * of a slash pair reads as a typo rather than as an absence.
 *
 * An absent arm is OMITTED entirely; a provider-reported `0` prints (`↓0`). When neither headline
 * quantity was reported the result is the empty string — chosen over a sentinel because it is falsy,
 * so the `<Show when={figure()}>` and `if (figure === "")` a caller already writes both fall out for
 * free, and because a sentinel that leaked into a frame would render as a measurement rather than as
 * an absence. Callers own the muted tone that empty string stands for; this module owns no colour.
 */
export function formatTokenFigure(q: TokenQuantities): string {
    return armsOf(q)
        .map((arm) => arm.compact)
        .join(" ");
}

/**
 * The LABELLED written form of a token figure: `767.6k in · 33.1k out`.
 *
 * For a figure that IS the subject of the surface it sits on — the rail's USAGE section, the usage
 * dialog's headline. Such a figure is read deliberately rather than scanned, so it can afford the
 * words and gains nothing from terseness; arrows there make the one thing the surface exists to
 * report the tersest thing on it.
 *
 * Identical to {@link formatTokenFigure} in everything except the writing: same quantities, same
 * arms, same omission of an absent arm, same empty string when neither was reported, same printed
 * provider-reported zero. Absence is a property of the DATA, so a quantity missing from one form and
 * printed as a zero in the other would make the two forms disagree about what was measured.
 *
 * A surface that also shows the nested cache/reasoning breakdowns cannot use this string: nesting
 * needs a position per arm, which a joined line has thrown away. Those surfaces take the arms from
 * {@link tokenFigureDetail} and print {@link TokenFigureArm.labelled} themselves — the same writing,
 * laid out per arm — and fall back to this joined line when nothing nests under either arm.
 */
export function formatTokenFigureLabelled(q: TokenQuantities): string {
    return armsOf(q)
        .map((arm) => arm.labelled)
        .join(` ${GLYPHS.middot} `);
}

/**
 * The detailed variant, for surfaces with the room: the same two arms both one-line forms are built
 * from, each carrying the quantities that are parts of it and both of its writings.
 *
 * Cache writes and cache reads nest under input because they are slices of the billed prefix that
 * `inputTokens` already counts. Reasoning nests under output because that is where a reader looks
 * for it and where the CLI's text report has always put it — noting that the harness reports it as
 * the provider stated it and never reconciles it against the output total, so it is a detail beside
 * a total rather than arithmetic that closes. Either way it is not a third headline, and no surface
 * renders one summed number at any grain.
 */
export function tokenFigureDetail(q: TokenQuantities): TokenFigureDetail {
    return {
        input: armOf(GLYPHS.arrowUp, "in", q.inputTokens, [
            ["cache write", q.cacheCreationInputTokens],
            ["cache read", q.cacheReadInputTokens],
        ]),
        output: armOf(GLYPHS.arrowDown, "out", q.outputTokens, [["reasoning", q.reasoningTokens]]),
    };
}
