import { Show } from "solid-js";

import { syntaxStyle, theme } from "../theme.ts";
import { GLYPHS, space } from "../../lib/design_system.ts";
import { Bold, Fg } from "./emphasis.tsx";
import type { PresentationBody } from "../../types/session.ts";

/** Props for {@link PresentationBlock}. */
export type PresentationBlockProps = {
    /** Optional heading shown above the content. */
    title?: string;
    /** The text-shaped body to render inline. */
    body: PresentationBody;
};

/**
 * Escape the pipe and backslash that would otherwise corrupt a markdown table cell, so a `|` in a table
 * value renders literally rather than splitting the row into extra columns.
 */
function cell(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Render a text-shaped `show_user` presentation body to the markdown source the `<markdown>` renderable
 * consumes: `markdown` verbatim, `code` as a fenced block (language-tagged), `table` as a GitHub-flavored
 * markdown table (with its caption as a trailing italic line). Keeping this a view concern — rather than
 * pre-rendering at receipt — lets the REPL printer render the same structured body its own way (aligned
 * text) without the store needing to hold two encodings.
 */
function toMarkdown(body: PresentationBody): string {
    switch (body.kind) {
        case "markdown":
            return body.body;
        case "code":
            return "```" + body.language + "\n" + body.code + "\n```";
        case "table": {
            const header = `| ${body.headers.map(cell).join(" | ")} |`;
            // Minimum separator row (one `-` per column) — the table renders regardless of column count.
            const divider = `|${body.headers.map(() => "-").join("|")}|`;
            const rows = body.rows.map((r) => `| ${body.headers.map((_, ci) => cell(r[ci] ?? "")).join(" | ")} |`);
            const table = [header, divider, ...rows].join("\n");
            return body.caption ? `${table}\n\n_${body.caption}_` : table;
        }
        default: {
            // Exhaustive: a new PresentationBody kind without a case fails the build here.
            const _exhaustive: never = body;
            return _exhaustive;
        }
    }
}

/**
 * The inline presentation block: agent-synthesized text-shaped content (`markdown`/`code`/`table`)
 * rendered through the existing `<markdown>` renderable — no open step. A `triangleRight` marker + bold
 * title head it when a title is present. The markdown config mirrors {@link MessageBlock}'s text part
 * exactly (`streaming` pinned true, `internalBlockMode="top-level"`) — see the note there for why.
 */
export function PresentationBlock(props: PresentationBlockProps) {
    const content = (): string => toMarkdown(props.body);
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <Show when={props.title}>
                <text>
                    <Fg role="accent">{`${GLYPHS.triangleRight} `}</Fg>
                    <Fg role="fg">
                        <Bold>{props.title}</Bold>
                    </Fg>
                </text>
            </Show>
            <markdown content={content()} fg={theme().fg} syntaxStyle={syntaxStyle()} streaming={true} internalBlockMode="top-level" paddingLeft={space.md} />
        </box>
    );
}
