/**
 * A catalog that holds its content in memory. A test, or a host with no user content, gives it to the harness.
 */

import type { Tool } from "../tools/define-tool.js";
import { skillIndex } from "../tools/sandbox/skills.js";
import type { AgentEquipment } from "./equip.js";
import type { AgentCatalog, AgentEntry, ConnectorSettings, McpServerConfig, SkillInfo, SkillStore } from "./types.js";

export type InMemorySkill = SkillInfo & {
    /** The files of the skill by relative path. `SKILL.md` is added from the name and the description when absent. */
    readonly files?: Readonly<Record<string, string>>;
};

export function createInMemorySkillStore(skills: readonly InMemorySkill[] = []): SkillStore {
    const byName = new Map<string, Readonly<Record<string, string>>>(
        skills.map((skill) => [
            skill.name,
            { "SKILL.md": `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`, ...skill.files },
        ]),
    );
    return {
        list: () => Promise.resolve(skills.map(({ name, description }) => ({ name, description }))),
        files: (skill) => Promise.resolve(Object.keys(byName.get(skill) ?? {}).sort()),
        read: (skill, path) => Promise.resolve(byName.get(skill)?.[path]),
        size: (skill, path) => {
            const text = byName.get(skill)?.[path];
            return Promise.resolve(text === undefined ? undefined : Buffer.byteLength(text));
        },
    };
}

export type InMemoryCatalogContent = {
    readonly agents?: readonly AgentEntry[];
    readonly skills?: SkillStore;
    readonly mcpServers?: readonly McpServerConfig[];
    readonly connectors?: readonly ConnectorSettings[];
    readonly credentials?: Readonly<Record<string, string>>;
};

export function createInMemoryCatalog(content: InMemoryCatalogContent = {}): AgentCatalog {
    return {
        agents: () => Promise.resolve(content.agents ?? []),
        skills: content.skills ?? createInMemorySkillStore(),
        mcpServers: () => Promise.resolve(content.mcpServers ?? []),
        connectors: () => Promise.resolve(content.connectors ?? []),
        credential: (name) => Promise.resolve(content.credentials?.[name]),
    };
}

/** The equipment of an agent with the given tools and skills: a test builds an agent without a catalog. */
export function equipmentOf(
    content: { readonly connectorTools?: readonly Tool[]; readonly skills?: readonly InMemorySkill[]; readonly connectorIds?: readonly string[] } = {},
): AgentEquipment {
    const skills = content.skills ?? [];
    return {
        connectorIds: content.connectorIds ?? [],
        connectorTools: content.connectorTools ?? [],
        skills: skills.map((skill) => skill.name),
        skillIndex: skillIndex(
            skills,
            skills.map((skill) => skill.name),
        ),
        skillStore: createInMemorySkillStore(skills),
        mcp: { direct: [], script: [] },
    };
}
