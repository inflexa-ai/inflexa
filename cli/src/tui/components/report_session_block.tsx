import { GLYPHS, space } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** Props for {@link ReportSessionBlock}. Purely presentational — the caller reads the row and owns the open. */
export type ReportSessionBlockProps = {
    /** The report session's title, already resolved to a word the reader can see (a row can carry none). */
    title: string;
    /** The last-activity readout, already written (the compact relative age the sidebar SESSION rail uses). */
    activityLabel: string;
    /** Open this report session (wired to a click on the entry). */
    onOpen: () => void;
};

/**
 * The report-session block: the entry a conversation shows for a report session that it spawned.
 *
 * The whole block is the click target, and the marker is the affordance. The marker is the plain right
 * arrow, and the contrast with the openable card is the reason: that card opens its rows OUTSIDE the
 * terminal and carries the north-east arrow for it, while this entry opens a session IN PLACE. One
 * arrow for each direction keeps the two readable side by side in one transcript.
 *
 * The second line names the kind. A title is seeded from the first message of the session, thus it
 * reads as a conversation title and says nothing about what the entry opens.
 */
export function ReportSessionBlock(props: ReportSessionBlockProps) {
    return (
        <box flexDirection="column" paddingBottom={space.sm} onMouseDown={() => props.onOpen()}>
            <text>
                <Fg role="accent">{`${GLYPHS.arrowRight} `}</Fg>
                <Fg role="fg">{props.title}</Fg>
                <Fg role="fgMuted">{` ${GLYPHS.middot} ${props.activityLabel}`}</Fg>
            </text>
            <text paddingLeft={space.md}>
                <Fg role="fgMuted">report session</Fg>
            </text>
        </box>
    );
}
