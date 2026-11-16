/**
 * `skill_search` + `skill_read` — an agent's access to its attached skills (method decision trees, API references,
 * worked examples). The tools read each file through the `SkillStore` of the catalog, and both are confined to the
 * attached skills: an agent cannot read a skill that it does not attach.
 *
 * `skill_search` is a keyword/substring match over the text files of the attached skills (no embedding index): the
 * skill set of one agent is a handful of skills, so a bounded scan is enough to route the agent to the right
 * reference. Expected outcomes are data variants — never throws on a missing skill, an undeclared skill, or no
 * matches.
 */

import { posix, win32 } from "node:path";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import type { SkillInfo, SkillStore } from "../../catalog/types.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { collapseWhitespace, splitLines } from "../../lib/text.js";

/** Bounds — keep a search over a deep skill tree cheap and context-safe. */
export const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_SNIPPET = 240;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 25;

export type SkillToolsDeps = {
    readonly store: SkillStore;
    /** The attached skills of the agent — the access allowlist. */
    readonly skills: readonly string[];
};

type SkillMatch = {
    readonly skill: string;
    readonly path: string;
    readonly line: number;
    readonly snippet: string;
    readonly score: number;
};

type SkillSearchOutput = { status: "no_skills" } | { status: "no_matches"; query: string } | { status: "ok"; query: string; matches: SkillMatch[] };

type SkillReadOutput =
    | { status: "no_skills" }
    | { status: "skill_not_declared"; skill: string }
    | { status: "out_of_scope"; skill: string; path: string }
    | { status: "not_found"; skill: string; path: string }
    | { status: "truncated"; skill: string; path: string; content: string; totalSize: number }
    | { status: "ok"; skill: string; path: string; content: string };

const SkillSearchInputSchema = z.object({
    query: z.string().min(1).describe("Keywords to match (e.g. 'PyDESeq2 contrast syntax')."),
    topK: z.number().int().min(1).max(MAX_TOP_K).optional().describe(`Max results to return. Defaults to ${DEFAULT_TOP_K}.`),
});

const SkillReadInputSchema = z.object({
    skill: z.string().min(1).describe("Skill name (one of your skills)."),
    path: z.string().min(1).optional().describe("File path within the skill, e.g. 'references/pydeseq2-api.md'. Omit it to read the SKILL.md of the skill."),
});

/** A path inside a skill: relative, with no `..` segment. */
function isInsideSkill(path: string): boolean {
    if (posix.isAbsolute(path) || win32.isAbsolute(path)) return false;
    return !path.replaceAll("\\", "/").split("/").includes("..");
}

export function createSkillTools(deps: SkillToolsDeps): {
    skillSearch: Tool<z.infer<typeof SkillSearchInputSchema>, SkillSearchOutput>;
    skillRead: Tool<z.infer<typeof SkillReadInputSchema>, SkillReadOutput>;
} {
    const allowed = new Set(deps.skills);
    const { store } = deps;

    const skillSearch = defineTool({
        id: "skill_search",
        concurrent: true,
        description:
            "Search your skills (method decision trees, API references, worked " +
            "examples) by keyword. Start here when picking a method or verifying an " +
            "API detail. The query splits on whitespace into words, and each word matches as a " +
            "case-insensitive substring. Returns one entry per matching skill file — its skill, its path, " +
            "and the first line that holds a query word — ranked by how many distinct query words the file " +
            "holds. Then `skill_read` the file. No matches returns a data variant.",
        inputSchema: SkillSearchInputSchema,
        view: "none",
        describeCall: "none",
        execute: async ({ query, topK }): Promise<Result<SkillSearchOutput, ToolError>> => {
            if (allowed.size === 0) {
                return ok({ status: "no_skills" as const });
            }
            const tokens = collapseWhitespace(query.toLowerCase()).split(" ").filter(Boolean);
            const matches: SkillMatch[] = [];

            for (const skill of allowed) {
                for (const path of await store.files(skill)) {
                    const size = await store.size(skill, path);
                    if (size === undefined || size > MAX_SKILL_FILE_BYTES) continue;
                    const content = await store.read(skill, path);
                    if (content === undefined) continue;
                    const lower = content.toLowerCase();
                    const distinct = tokens.filter((t) => lower.includes(t)).length;
                    if (distinct === 0) continue;

                    const lines = splitLines(content);
                    const hitIdx = lines.findIndex((l) => {
                        const ll = l.toLowerCase();
                        return tokens.some((t) => ll.includes(t));
                    });
                    const line = lines[hitIdx] ?? "";
                    matches.push({ skill, path, line: hitIdx + 1, snippet: line.trim().slice(0, MAX_SNIPPET), score: distinct });
                }
            }

            if (matches.length === 0) {
                return ok({ status: "no_matches" as const, query });
            }
            matches.sort((a, b) => b.score - a.score);
            return ok({
                status: "ok" as const,
                query,
                matches: matches.slice(0, topK ?? DEFAULT_TOP_K),
            });
        },
    });

    const skillRead = defineTool({
        id: "skill_read",
        concurrent: true,
        description:
            "Read a file from one of your skills: its SKILL.md when you name no path, or a reference " +
            "that skill_search found. Confined to your skills. An unknown skill and a missing path " +
            "return a data variant.",
        inputSchema: SkillReadInputSchema,
        view: "none",
        describeCall: "none",
        execute: async ({ skill, path = "SKILL.md" }): Promise<Result<SkillReadOutput, ToolError>> => {
            if (allowed.size === 0) {
                return ok({ status: "no_skills" as const });
            }
            if (!allowed.has(skill)) {
                return ok({ status: "skill_not_declared" as const, skill });
            }
            if (!isInsideSkill(path)) {
                return ok({ status: "out_of_scope" as const, skill, path });
            }
            const size = await store.size(skill, path);
            const content = size === undefined ? undefined : await store.read(skill, path);
            if (size === undefined || content === undefined) {
                return ok({ status: "not_found" as const, skill, path });
            }
            if (size > MAX_SKILL_FILE_BYTES) {
                const cut = Buffer.from(content, "utf8").subarray(0, MAX_SKILL_FILE_BYTES).toString("utf8");
                return ok({ status: "truncated" as const, skill, path, content: cut, totalSize: size });
            }
            return ok({ status: "ok" as const, skill, path, content });
        },
    });

    return { skillSearch, skillRead };
}

/**
 * The first level of the skills of an agent: one entry for each attached skill, from the description that the store
 * lists. The agent reads a `SKILL.md` and its references only when the work needs them. The text depends only on the
 * attached skills and the store, thus it stays the same for each step of one agent.
 */
export function skillIndex(listed: readonly SkillInfo[], skills: readonly string[]): string | undefined {
    const descriptions = new Map(listed.map((skill) => [skill.name, skill.description]));
    const entries = skills.map((skill) => {
        const description = descriptions.get(skill)?.trim();
        return description === undefined || description.length === 0 ? `- \`${skill}\`` : `- \`${skill}\`: ${description}`;
    });
    if (entries.length === 0) return undefined;
    return [
        "## Your Skills",
        "",
        "Skills hold the decision trees, the API references, the worked examples, and the anti-patterns of each domain. They are your authoritative source on methods: find the guidance with `skill_search`, then read it with `skill_read`. A `SKILL.md` holds the method guidance, and its references hold the API of each library.",
        "",
        ...entries,
    ].join("\n");
}
