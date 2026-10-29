import { GLYPHS, space } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** Props for {@link ReportRenderedBlock}. Purely presentational: the caller writes the labels and owns the open. */
export type ReportRenderedBlockProps = {
    /** The title of the rendered document, when it has one. */
    title?: string;
    /** The age of the render, already written (the compact relative age of the sidebar). */
    renderedLabel: string;
    /** Open the page of the session in the browser (wired to a click on the entry). */
    onOpen: () => void;
};

/**
 * One render of the page of a report session: a quiet line that opens the page.
 *
 * The page opens outside the terminal, thus the marker is the north-east arrow of the openable card. Each
 * render opens the same live page, thus an earlier render opens the page of now, not the page of then.
 */
export function ReportRenderedBlock(props: ReportRenderedBlockProps) {
    return (
        <box flexDirection="column" paddingBottom={space.sm} onMouseDown={() => props.onOpen()}>
            <text>
                <Fg role="accent">{`${GLYPHS.arrowUpRight} `}</Fg>
                <Fg role="fg">{props.title === undefined ? "Page rendered" : `Page rendered: ${props.title}`}</Fg>
                <Fg role="fgMuted">{` ${GLYPHS.middot} ${props.renderedLabel}`}</Fg>
            </text>
        </box>
    );
}
