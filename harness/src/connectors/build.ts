import type { AgentCatalog } from "../catalog/types.js";
import type { ResolvedCatalog } from "../catalog/resolve.js";
import type { Tool } from "../tools/define-tool.js";
import { CONNECTORS, type ConnectorContext } from "./registry.js";

/** What each connector of one agent shares: the services of the composition, not the settings of a connector. */
export type ConnectorBase = Omit<ConnectorContext, "credential" | "endpoint">;

/**
 * The tools of the attached connectors of one agent. The credentials are read from the catalog at this call, thus a
 * new value reaches the next turn or the next step. A value is never written into a workflow input or a step output.
 */
export async function buildConnectorTools(
    catalog: Pick<AgentCatalog, "credential">,
    resolved: Pick<ResolvedCatalog, "connectors">,
    connectorIds: readonly string[],
    base: ConnectorBase,
): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    for (const id of connectorIds) {
        const definition = CONNECTORS.get(id);
        const settings = resolved.connectors.get(id);
        if (definition === undefined || settings === undefined) continue;
        const values = new Map<string, string | undefined>();
        for (const slot of Object.keys(definition.credentials)) {
            values.set(slot, await catalog.credential(settings.credentials?.[slot] ?? slot));
        }
        const context: ConnectorContext = {
            ...base,
            credential: (slot) => values.get(slot),
            endpoint: settings.endpoint ?? definition.defaultEndpoint,
        };
        for (const tool of definition.tools(context)) {
            if (seen.has(tool.id)) continue;
            seen.add(tool.id);
            tools.push(tool);
        }
    }
    return tools;
}

/** The live lookups of an agent: the outside service of each attached connector that holds data. */
export function liveSourcesOf(connectorIds: readonly string[]): readonly string[] {
    return connectorIds.flatMap((id) => {
        const source = CONNECTORS.get(id)?.liveSource;
        return source === undefined || source === null ? [] : [source];
    });
}
