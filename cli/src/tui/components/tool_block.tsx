import { useTerminalDimensions } from "@opentui/solid";
import { Show } from "solid-js";
import type { Accessor } from "solid-js";

import { syntaxStyle, theme } from "../theme.ts";
import { GLYPHS, size, space, stroke, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/**
 * Floor for the measured content width, so a very narrow terminal still yields a usable
 * number rather than zero or a negative one. At the floor every detail simply splits.
 */
const MIN_CONTENT_WIDTH = 24;

/** Props for {@link ToolBlock}. */
export type ToolBlockProps = {
    /** Tool/verb name, e.g. `read_file`. */
    name: string;
    /**
     * One line naming what this call is doing, e.g. `hypothesis retire h3`.
     *
     * OPAQUE display text owned by the harness — rendered, never parsed. It sits on the name line
     * when it fits and drops to its own row when it does not; it is never truncated, because the
     * end of a workspace path is the part that identifies the file.
     */
    detail?: string;
    /** The tool's textual result/output, rendered in a `<code>` panel. Absent for live harness tool events. */
    result?: string;
    /** Source filetype for syntax highlighting of `result` (e.g. `ts`). Absent for live harness tool events. */
    filetype?: string;
    /** Lifecycle of the call. */
    status: "running" | "ok" | "error" | "denied";
    /** Wall-clock duration in ms, shown beside a finished outcome; absent while running. */
    durationMs?: number;
    /**
     * What the innermost sub-agent working inside this call is doing right now.
     *
     * Rendered as ONE subordinate line, and only while the call is `running` — a finished call has an
     * outcome, which is a better answer to the same question. Without it a long tool call is
     * indistinguishable from a wedged one; with the sub-agent's own events as blocks instead, they
     * would bury the conversation.
     */
    activity?: string;
    /**
     * Whether the outcome is folded onto the name line (`▸ name target  ✓ ok · 14ms`) instead of a
     * standalone completion line below the result panel. Defaults to `props.result === undefined`: a
     * live event carries no output, so its status reads best inline, whereas a result-carrying block
     * keeps the outcome under its `<code>` panel — inlining it there would strand the status above the
     * output it summarizes. An explicit value overrides the derivation.
     */
    inlineStatus?: boolean;
};

/** The glyph, color role, and label for a tool call's lifecycle state. */
function statusView(status: ToolBlockProps["status"]): { glyph: string; role: "success" | "warning" | "error"; label: string } {
    if (status === "error") return { glyph: GLYPHS.cross, role: "error", label: "error" };
    // A refused approval takes the soft glyph, not the cross: nothing failed, the user declined.
    // Painting a decision as a fault tells them their own choice went wrong.
    if (status === "denied") return { glyph: GLYPHS.warning, role: "warning", label: "denied" };
    if (status === "running") return { glyph: GLYPHS.triangleRight, role: "warning", label: "running" };
    return { glyph: GLYPHS.check, role: "success", label: "ok" };
}

/**
 * The tool-call block: the `▸` marker with the tool/verb name (in the `tool`
 * role) and its optional call detail, the optional result in a bordered `<code>`
 * panel with syntax highlighting, and a status carrying the outcome and its
 * duration. Live harness tool events carry no result payload, so the result panel
 * appears only for the fixture-rich mock. The verb name is the
 * only thing painted in the `tool` role — everything else stays in text/meta roles.
 * The status folds onto the name line for a result-less live event and drops to its
 * own completion line below the result panel otherwise (see {@link ToolBlockProps.inlineStatus}).
 *
 * A detail that does not fit the name line reflows to its own indented row rather than
 * being cut. Truncation would eat the tail of a workspace path, which is the segment that
 * names the file — and the detail is one opaque harness string, so the block cannot elide
 * its middle intelligently.
 */
export function ToolBlock(props: ToolBlockProps) {
    const dims = useTerminalDimensions();
    const inline = (): boolean => props.inlineStatus ?? props.result === undefined;
    // The leading ` · ` glues the duration onto the outcome label; the value is delegated to
    // Date.formatDuration so this line shares one ms/s/m vocabulary with every other readout.
    const duration = (): string => {
        const ms = props.durationMs;
        if (ms === undefined) return "";
        return ` ${GLYPHS.middot} ${Date.formatDuration(ms)}`;
    };
    // Subtract the sidebar rail unconditionally, as plan_card_block does, even though the rail is
    // toggleable. The two failure directions are not symmetric: over-subtracting costs one extra
    // row, while under-subtracting lets the line soft-wrap to column 0 and collide with the marker
    // gutter. Bias toward the harmless one.
    const contentWidth = (): number => Math.max(MIN_CONTENT_WIDTH, dims().width - size.railWidth - space.md - size.gutter);
    const statusWidth = (): number => {
        if (!inline()) return 0;
        const view = statusView(props.status);
        // space.md lead + single-cell glyph + separating space + label + duration.
        return space.md + 1 + 1 + view.label.length + duration().length;
    };
    // The name line's cost with the detail on it — the marker gutter, the name, the space before
    // the detail, the detail, and the status that follows.
    const detailFitsNameLine = (): boolean => {
        const detail = props.detail;
        if (detail === undefined) return true;
        return size.gutter + props.name.length + 1 + detail.length + statusWidth() <= contentWidth();
    };
    const inlineDetail = (): string | undefined => (detailFitsNameLine() ? props.detail : undefined);
    const reflowedDetail = (): string | undefined => (detailFitsNameLine() ? undefined : props.detail);
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role="fgMuted">{`${MARKERS.tool.glyph} `}</Fg>
                <Fg role="tool">{props.name}</Fg>
                <Show when={inlineDetail()}>
                    <Fg role="fgMuted">{` ${inlineDetail()}`}</Fg>
                </Show>
                <Show when={inline()}>
                    {/* Flow the status AFTER the name/detail rather than right-aligning it. A right-aligned
                        segment (a row with a flexGrow spacer) that soft-wraps lands its glyphs at column 0,
                        colliding with the 2-cell marker gutter; flowing it inline lets a narrow terminal wrap
                        the whole line while the gutter stays intact. This holds on the reflowed form too —
                        moving the detail off the line shortens it but does not make right-alignment safe.
                        The two-space (space.md) lead sets it off from the preceding detail (or the name). */}
                    <Fg role={statusView(props.status).role}>{`${" ".repeat(space.md)}${statusView(props.status).glyph} ${statusView(props.status).label}`}</Fg>
                    <Fg role="fgMuted">{duration()}</Fg>
                </Show>
            </text>
            {/* The reflowed detail. It precedes the activity row because it describes the call, which is
                fixed for the call's whole life, whereas the activity describes the moment and changes. */}
            <Show when={reflowedDetail()}>
                {(detail: Accessor<string>) => (
                    // The indent lives on a wrapping <box>, not as paddingLeft on the <text>: opentui
                    // ignores padding on a text renderable, so the prop form renders flush against the
                    // gutter and the row stops reading as subordinate to the call above it.
                    <box paddingLeft={space.md}>
                        <text>
                            <Fg role="fgMuted">{detail()}</Fg>
                        </text>
                    </box>
                )}
            </Show>
            {/* The sub-agent activity line: one line, indented under the call it belongs to, and gone
                the moment the call finishes. Gated on `running` here rather than only at the source,
                so a block handed a stale activity with a terminal status still renders honestly. */}
            <Show when={props.status === "running" && props.activity}>
                {(activity: Accessor<string>) => (
                    // Same wrapping <box> as the detail row above, and for the same reason: opentui
                    // ignores padding on a text renderable, so both subordinate rows would otherwise
                    // sit flush against the gutter instead of under the call they belong to.
                    <box paddingLeft={space.md}>
                        <text>
                            <Fg role="fgMuted">{`${GLYPHS.arrowRight} ${activity()}`}</Fg>
                        </text>
                    </box>
                )}
            </Show>
            <Show when={props.result}>
                <box
                    marginTop={space.sm}
                    paddingLeft={space.sm}
                    paddingRight={space.sm}
                    borderStyle={stroke.panel}
                    borderColor={theme().border}
                    backgroundColor={theme().bgRaised}
                >
                    {/* `fg` is NOT redundant with the syntaxStyle "default" scope: when tree-sitter yields
                        zero highlights (filetype "text"), CodeRenderable paints the whole buffer via
                        setText() using the renderable's own default fg — bypassing chunk styling entirely.
                        Unset, that default is opentui's white; pin it to the theme fg so plain results read. */}
                    <code content={props.result ?? ""} filetype={props.filetype ?? "text"} fg={theme().fg} syntaxStyle={syntaxStyle()} />
                </box>
            </Show>
            <Show when={!inline()}>
                <text>
                    <Fg role={statusView(props.status).role}>{`${statusView(props.status).glyph} ${statusView(props.status).label}`}</Fg>
                    <Fg role="fgMuted">{duration()}</Fg>
                </text>
            </Show>
        </box>
    );
}
