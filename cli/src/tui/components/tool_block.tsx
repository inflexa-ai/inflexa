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
 * panel with syntax highlighting, and a status line carrying the outcome and its
 * duration. Live harness tool events carry only the name/outcome/duration, so the
 * target/result panel appears only for the fixture-rich mock. The verb name is the
 * only thing painted in the `tool` role — everything else stays in text/meta roles.
 */
export function ToolBlock(props: ToolBlockProps) {
    // Compact human duration for the completed line; whole ms under a second, else one decimal second.
    const duration = (): string => {
        const ms = props.durationMs;
        if (ms === undefined) return "";
        return ms < 1000 ? ` ${GLYPHS.middot} ${ms}ms` : ` ${GLYPHS.middot} ${(ms / 1000).toFixed(1)}s`;
    };
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role="fgMuted">{`${MARKERS.tool.glyph} `}</Fg>
                <Fg role="tool">{props.name}</Fg>
                <Show when={props.target}>
                    <Fg role="fgMuted">{` ${props.target}`}</Fg>
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
            <text>
                <Fg role={statusView(props.status).role}>{`${statusView(props.status).glyph} ${statusView(props.status).label}`}</Fg>
                <Fg role="fgMuted">{duration()}</Fg>
            </text>
        </box>
    );
}
