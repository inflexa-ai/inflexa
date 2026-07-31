import type { JSX } from "solid-js";

import { GLYPHS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/**
 * The separator between two facts on one line — ` · `.
 *
 * A span of its own rather than a character glued onto the fact beside it, because the facts a line
 * carries do not share a tone: a run's age is muted, a retry count is `warning`, a reported figure is
 * data-toned and an unreported one muted. A separator folded into either neighbour inherits that
 * neighbour's colour, so the line's punctuation would change tone as a step retried or a figure
 * arrived — the punctuation flickering while the content is what actually changed.
 *
 * `fgSubtle`, the decoration tier: a middot carries no information of its own, so it is one of the
 * things the 4.5:1 text floor deliberately exempts (it still clears 3:1). At the text tier the
 * punctuation would carry the same weight as the measurements it separates, which on a rail row of
 * four facts is most of what the eye lands on.
 *
 * Shared rather than re-spelled per surface for the reason every other piece of this vocabulary is:
 * two surfaces separating their facts at two different tones is a difference a reader tries to
 * interpret.
 */
export function Sep(): JSX.Element {
    return <Fg role="fgSubtle">{` ${GLYPHS.middot} `}</Fg>;
}
