/**
 * Briefings — declarative, typed, pure injectable context blocks.
 *
 * There is NO auto-discovery: a caller composes the briefings a loop receives
 * explicitly, in array order, at its call site (see the conversation-briefings
 * spec, D3). This barrel re-exports the contract, the injection path, and the
 * concrete definitions a caller binds.
 */

export type { BriefingDefinition, BriefingMode, RenderedBriefing } from "./types.js";
export { composeBriefing, wrapBriefingContent, type ComposedBriefing } from "./compose.js";
export { dataProfileBriefing, DATA_PROFILE_BRIEFING_NAME } from "./data-profile.js";
