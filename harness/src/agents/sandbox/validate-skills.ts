/**
 * Boot-time skill validation.
 *
 * Verifies that SKILLS_DIR exists and every skill name declared by a sandbox
 * agent resolves to a readable SKILL.md. Catches Dockerfile drift and typos
 * in agent meta before the first analysis runs.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal shape this validator reads — `id` for diagnostics and `skills`
 * for the per-agent skill list. Declared structurally so `AgentMeta` types
 * with `readonly` arrays work without a cast at the call site.
 */
interface AgentMetaLike {
    readonly id: string;
    readonly skills: readonly string[];
}

export function validateAgentSkills(skillsDir: string, catalog: Readonly<Record<string, AgentMetaLike>>): void {
    try {
        const s = statSync(skillsDir);
        if (!s.isDirectory()) {
            throw new Error(`SKILLS_DIR "${skillsDir}" is not a directory`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `SKILLS_DIR "${skillsDir}" is not accessible: ${msg}. ` + `Set SKILLS_DIR to a directory containing skill subfolders (one SKILL.md each).`,
        );
    }

    const missing: Array<{ agentId: string; skill: string; expectedPath: string }> = [];
    for (const meta of Object.values(catalog)) {
        for (const skill of meta.skills) {
            const skillFile = join(skillsDir, skill, "SKILL.md");
            try {
                const s = statSync(skillFile);
                if (!s.isFile()) {
                    missing.push({ agentId: meta.id, skill, expectedPath: skillFile });
                }
            } catch {
                missing.push({ agentId: meta.id, skill, expectedPath: skillFile });
            }
        }
    }

    if (missing.length > 0) {
        const lines = missing.map((m) => `  - agent "${m.agentId}" declares skill "${m.skill}" but ${m.expectedPath} is missing`).join("\n");
        throw new Error(`Skill validation failed: ${missing.length} declared skill(s) not found under SKILLS_DIR="${skillsDir}":\n${lines}`);
    }
}
