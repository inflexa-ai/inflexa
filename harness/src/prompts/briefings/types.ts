/**
 * Briefing contract — the declarative, pure definition of one injectable
 * context block (see the conversation-briefings spec).
 *
 * A briefing carries context an agent loop needs from its first turn that
 * belongs neither in the system prompt (agent-lifetime, cache-hostile to
 * change, always loaded) nor in the volatile tail (reserved for per-turn
 * state). `mode` selects the single behavior bundle:
 *
 *   - `"standing"` — injected once at conversation start, immutable for the
 *     thread's lifetime, persisted, pinned ahead of the history window.
 *   - `"rolling"` — re-rendered every turn at the tail, never persisted.
 *
 * The two illegal combinations are unrepresentable because `mode` is one
 * field: a prefix block re-rendered every turn would bust the prompt cache,
 * and a pinned tail block is a plain message after one turn.
 *
 * `render` is PURE — no I/O, no clock, no ambient state — so a definition is
 * renderable and snapshot-testable in isolation from a colocated fixture. The
 * `<briefing>` wire wrapping is applied by the injection path (`compose.ts`),
 * never by a definition: definitions carry plain content.
 */

export type BriefingMode = "standing" | "rolling";

/** The pure product of a briefing's `render`. */
export interface RenderedBriefing {
    /** The full wire content the model sees, before `<briefing>` wrapping. */
    readonly content: string;
    /** A one-line, at-a-glance summary carried on the briefing-card event. */
    readonly caption: string;
}

/** A declarative, typed, pure definition of one injectable context block. */
export interface BriefingDefinition<TInput> {
    /** Registry key — also the `name` attribute of the `<briefing>` wrapper. */
    readonly name: string;
    /** One line stating what the agent is being made aware of. */
    readonly description: string;
    /** The single field deriving placement, refresh, persistence, and caching. */
    readonly mode: BriefingMode;
    /** Pure: turn a typed input into wire content + caption. No I/O. */
    render(input: TInput): RenderedBriefing;
}
