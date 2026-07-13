/**
 * Briefing injection path — the ONE place the uniform `<briefing>` wire
 * convention lives (see the conversation-briefings spec, D4).
 *
 * A `BriefingDefinition.render` returns plain content; this module wraps it
 * into a single `user` message tagged `<briefing name="…">…</briefing>` so
 * briefings are independently addressable in storage and on the wire, and the
 * wire convention is not duplicated across definitions. A `ComposedBriefing`
 * is the ready-to-inject unit: the standing path persists it (as a `briefing`
 * envelope) and emits a briefing-card event from its `name`/`caption`; a
 * sub-agent loop can pass its `message` as an unpersisted initial message.
 */

import type { ModelMessage } from "ai";

import type { BriefingDefinition } from "./types.js";

/** One rendered, wire-wrapped briefing — ready to inject and/or persist. */
export interface ComposedBriefing {
    /** The definition `name` — the registry key and card identity. */
    readonly name: string;
    /** The rendered one-line caption for the briefing-card event. */
    readonly caption: string;
    /** The `user` message carrying the `<briefing>`-wrapped content. */
    readonly message: ModelMessage;
}

/** Wrap rendered content in the uniform `<briefing name="…">` envelope. */
export function wrapBriefingContent(name: string, content: string): string {
    return `<briefing name="${name}">\n${content}\n</briefing>`;
}

/**
 * Render a definition against its typed input and wrap the result into a
 * single `user` briefing message. Pure — it only calls `def.render` and wraps.
 */
export function composeBriefing<TInput>(def: BriefingDefinition<TInput>, input: TInput): ComposedBriefing {
    const { content, caption } = def.render(input);
    return {
        name: def.name,
        caption,
        message: { role: "user", content: wrapBriefingContent(def.name, content) },
    };
}
