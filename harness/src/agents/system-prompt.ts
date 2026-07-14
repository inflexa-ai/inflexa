/**
 * Harness system-prompt composition.
 *
 * SOUL is static text — there is no processor pipeline. `composeSystemPrompt`
 * concatenates the SOUL layers an agent declares with the agent's own prompt
 * into the single `AgentDefinition.systemPrompt` string the loop sends as the
 * cacheable prefix. It is the only place SOUL is applied, and every agent is
 * built through it — an unguarded agent is not constructible.
 *
 * The layer policy:
 *
 * - `SOULExecutionCore` is **always** included; there is no opt-out. The
 *   scientific stance and the hard guardrails (never fabricate, never oversell,
 *   never hide uncertainty, confidentiality, prompt-injection defense) bind a
 *   headless agent exactly as they bind the user-facing one. The run
 *   synthesizer and the report builder author user-facing scientific claims
 *   without a human in their loop — they are the last agents that should be
 *   free to fabricate.
 *
 * - `identity` (default `false`) adds `SOULIdentity` — the Inflexa name, the
 *   scope, and the human-facing refusal / impersonation / external-action
 *   guardrails. Only the conversation agent faces a human, so only it opts in.
 *
 * - `conversational` (default `false`) adds `SOULConversationalPrompt` —
 *   personality, response policy, and the 7-step reasoning cadence. Conversation
 *   agent only: a tool-only specialist's tight loop competes with conversational
 *   discipline.
 *
 * Both flags default off, so the zero-argument call yields a fully guarded
 * headless agent — the safe default is also the shortest one to write.
 */

import { SOULExecutionCore, SOULIdentity, SOULConversationalPrompt } from "../prompts/SOUL.js";

export interface ComposeSystemPromptOptions {
    /**
     * Include the SOUL identity layer (name, scope, refusal of harmful
     * requests, impersonation and external-action guardrails). Default `false`
     * — opt in only for an agent a human talks to.
     */
    readonly identity?: boolean;
    /**
     * Include the SOUL conversational layer (personality, response policy,
     * 7-step reasoning). Default `false` — opt in only for the conversation
     * agent.
     */
    readonly conversational?: boolean;
}

/**
 * Compose an agent's full system prompt: the always-on SOUL execution core, the
 * layers the agent opted into, then the agent's own prompt — joined by blank
 * lines.
 */
export function composeSystemPrompt(agentPrompt: string, options: ComposeSystemPromptOptions = {}): string {
    const sections: string[] = [SOULExecutionCore];
    if (options.identity ?? false) sections.push(SOULIdentity);
    if (options.conversational ?? false) sections.push(SOULConversationalPrompt);
    sections.push(agentPrompt);
    return sections.map((s) => s.trim()).join("\n\n");
}
