/**
 * Harness system-prompt composition.
 *
 * SOUL is static text — there is no processor pipeline. `composeSystemPrompt`
 * concatenates the SOUL kernel, the optional SOUL conversational layer, and an
 * agent's own prompt into the single `AgentDefinition.systemPrompt` string the
 * loop sends as the cacheable prefix.
 *
 * `includeConversationalStyle` toggles the conversational block: the
 * user-facing conversation agent keeps it; internal tool-only specialists
 * (planner, run-synthesizer) and sandbox agents omit it — their tight tool
 * loops compete with conversational discipline.
 */

import { SOULKernelPrompt, SOULConversationalPrompt } from "../prompts/SOUL.js";

export interface ComposeSystemPromptOptions {
    /**
     * Include the SOUL conversational layer (personality, response policy,
     * 7-step reasoning). Default `true` — opt out for internal specialists.
     */
    readonly includeConversationalStyle?: boolean;
}

/**
 * Compose an agent's full system prompt: SOUL kernel, the optional SOUL
 * conversational layer, then the agent's own prompt — joined by blank lines.
 */
export function composeSystemPrompt(agentPrompt: string, options: ComposeSystemPromptOptions = {}): string {
    const includeConversational = options.includeConversationalStyle ?? true;
    const sections = includeConversational ? [SOULKernelPrompt, SOULConversationalPrompt, agentPrompt] : [SOULKernelPrompt, agentPrompt];
    return sections.map((s) => s.trim()).join("\n\n");
}
