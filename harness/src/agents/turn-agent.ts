import type { AgentDefinition } from "../loop/types.js";

/**
 * An agent of a chat thread. Its fixed parts are made one time, with the assembly. Each turn builds the
 * `AgentDefinition` of the turn from the agent catalog of the moment, thus a change of the catalog reaches the next
 * turn, and the tools stay the same for the whole turn.
 */
export type TurnAgent = {
    readonly id: string;
    readonly forTurn: () => Promise<AgentDefinition>;
};

/** A turn agent whose definition does not change: a test, or a thread type with no catalog attachments. */
export function fixedTurnAgent(agent: AgentDefinition): TurnAgent {
    return { id: agent.id, forTurn: () => Promise.resolve(agent) };
}
