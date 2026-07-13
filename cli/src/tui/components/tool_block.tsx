import { Show } from "solid-js";

import { syntaxStyle, theme } from "../theme.ts";
import { GLYPHS, space, stroke, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** Props for {@link ToolBlock}. */
export type ToolBlockProps = {
    /** Tool/verb name, e.g. `read_file`. */
    name: string;
    /** What the tool acted on, e.g. a file path with a line range. Absent for live harness tool events. */
    target?: string;
    /** The tool's textual result/output, rendered in a `<code>` panel. Absent for live harness tool events. */
    result?: string;
    /** Source filetype for syntax highlighting of `result` (e.g. `ts`). Absent for live harness tool events. */
    filetype?: string;
    /** Lifecycle of the call. */
    status: "running" | "ok" | "error";
    /** Wall-clock duration in ms, shown beside a finished outcome; absent while running. */
    durationMs?: number;
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
    if (status === "running") return { glyph: GLYPHS.triangleRight, role: "warning", label: "running" };
    return { glyph: GLYPHS.check, role: "success", label: "ok" };
}

/**
 * The tool-call block: the `▸` marker with the tool/verb name (in the `tool`
 * role) and its optional target, the optional result in a bordered `<code>`
 * panel with syntax highlighting, and a status carrying the outcome and its
 * duration. Live harness tool events carry only the name/outcome/duration, so the
 * target/result panel appears only for the fixture-rich mock. The verb name is the
 * only thing painted in the `tool` role — everything else stays in text/meta roles.
 * The status folds onto the name line for a result-less live event and drops to its
 * own completion line below the result panel otherwise (see {@link ToolBlockProps.inlineStatus}).
 */
export function ToolBlock(props: ToolBlockProps) {
    const inline = (): boolean => props.inlineStatus ?? props.result === undefined;
    // The leading ` · ` glues the duration onto the outcome label; the value is delegated to
    // Date.formatDuration so this line shares one ms/s/m vocabulary with every other readout.
    const duration = (): string => {
        const ms = props.durationMs;
        if (ms === undefined) return "";
        return ` ${GLYPHS.middot} ${Date.formatDuration(ms)}`;
    };
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role="fgMuted">{`${MARKERS.tool.glyph} `}</Fg>
                <Fg role="tool">{props.name}</Fg>
                <Show when={props.target}>
                    <Fg role="fgMuted">{` ${props.target}`}</Fg>
                </Show>
                <Show when={inline()}>
                    {/* Flow the status AFTER the name/target rather than right-aligning it. A right-aligned
                        segment (a row with a flexGrow spacer) that soft-wraps lands its glyphs at column 0,
                        colliding with the 2-cell marker gutter; flowing it inline lets a narrow terminal wrap
                        the whole line while the gutter stays intact. The two-space (space.md) lead sets it off
                        from the preceding target (or the name, when there is no target). */}
                    <Fg role={statusView(props.status).role}>{`${" ".repeat(space.md)}${statusView(props.status).glyph} ${statusView(props.status).label}`}</Fg>
                    <Fg role="fgMuted">{duration()}</Fg>
                </Show>
            </text>
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
