import { Show } from "solid-js";

import { syntaxStyle, theme } from "../theme.ts";
import { GLYPHS, space, stroke, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** Props for {@link ToolBlock}. */
export type ToolBlockProps = {
    /** Tool/verb name, e.g. `read_file`. */
    name: string;
    /** What the tool acted on, e.g. a file path with a line range. */
    target: string;
    /** The tool's textual result/output, rendered in a `<code>` panel. */
    result: string;
    /** Source filetype for syntax highlighting of `result` (e.g. `ts`). */
    filetype: string;
    /** Lifecycle of the call. */
    status: "running" | "ok" | "error";
};

/**
 * The tool-call block: the `▸` marker with the tool/verb name (in the `tool`
 * role) and its target, the result in a bordered `<code>` panel with syntax
 * highlighting, and a status line. The verb name is the only thing painted in
 * the `tool` role — everything else stays in the standard text/meta roles.
 */
export function ToolBlock(props: ToolBlockProps) {
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role="fgMuted">{`${MARKERS.tool.glyph} `}</Fg>
                <Fg role="tool">{props.name}</Fg>
                <Fg role="fgMuted">{` ${props.target}`}</Fg>
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
                    <code content={props.result} filetype={props.filetype} syntaxStyle={syntaxStyle()} />
                </box>
            </Show>
            <text fg={props.status === "error" ? theme().error : theme().success}>
                {props.status === "error" ? GLYPHS.cross : GLYPHS.check} {props.status}
            </text>
        </box>
    );
}
