/**
 * `skill_search` + `skill_read` — a sandbox agent's access to its declared
 * skills (method decision trees, API references, worked examples) living as
 * `SKILL.md` + reference files under `SKILLS_DIR/{skill}/`.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): captures `skillsDir` and the agent's
 * declared skill allowlist (`meta.skills`). Both tools are confined to that
 * allowlist — an agent cannot read another agent's skills.
 *
 * `skill_search` is a keyword/substring match over the declared skills' text
 * files (no embedding index): the per-agent skill set is a handful of
 * directories, so a bounded scan is enough to route the agent to the right
 * reference. Expected outcomes are data variants — never throws on a missing
 * skill, an undeclared skill, or no matches.
 */

import { readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { collapseWhitespace, splitLines } from "../../lib/text.js";

/** Bounds — keep a search over a deep skill tree cheap and context-safe. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNIPPET = 240;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 25;
/** The file-name extensions a skill may carry text in. */
const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".py", ".r", ".R", ".json", ".yaml", ".yml", ".csv", ".tsv"];

export type SkillToolsDeps = {
    /** Absolute path to the skills tree (one subdirectory per skill). */
    readonly skillsDir: string;
    /** The agent's declared skills (`meta.skills`) — the access allowlist. */
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
    | { status: "skill_not_declared"; skill: string }
    | { status: "out_of_scope"; skill: string; path: string }
    | { status: "not_found"; skill: string; path: string }
    | { status: "truncated"; skill: string; path: string; content: string; totalSize: number }
    | { status: "ok"; skill: string; path: string; content: string };

async function collectTextFiles(dir: string, acc: string[]): Promise<void> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            await collectTextFiles(full, acc);
        } else if (TEXT_EXTENSIONS.some((extension) => e.name.endsWith(extension))) {
            acc.push(full);
        }
    }
}

const SkillSearchInputSchema = z.object({
    query: z.string().min(1).describe("Keywords to match (e.g. 'PyDESeq2 contrast syntax')."),
    topK: z.number().int().min(1).max(MAX_TOP_K).optional().describe(`Max results to return. Defaults to ${DEFAULT_TOP_K}.`),
});

const SkillReadInputSchema = z.object({
    skill: z.string().min(1).describe("Skill name (one of your declared skills)."),
    path: z.string().min(1).describe("File path within the skill, e.g. 'SKILL.md' or 'references/pydeseq2-api.md'."),
});

export function createSkillTools(deps: SkillToolsDeps): {
    skillSearch: Tool<z.infer<typeof SkillSearchInputSchema>, SkillSearchOutput>;
    skillRead: Tool<z.infer<typeof SkillReadInputSchema>, SkillReadOutput>;
} {
    const allowed = new Set(deps.skills);

    const skillSearch = defineTool({
        id: "skill_search",
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
                const skillRoot = resolve(deps.skillsDir, skill);
                const files: string[] = [];
                await collectTextFiles(skillRoot, files);
                for (const file of files) {
                    let content: string;
                    try {
                        const s = await stat(file);
                        if (s.size > MAX_FILE_BYTES) continue;
                        content = await readFile(file, "utf8");
                    } catch {
                        continue;
                    }
                    const lower = content.toLowerCase();
                    const distinct = tokens.filter((t) => lower.includes(t)).length;
                    if (distinct === 0) continue;

                    const lines = splitLines(content);
                    const hitIdx = lines.findIndex((l) => {
                        const ll = l.toLowerCase();
                        return tokens.some((t) => ll.includes(t));
                    });
                    const line = lines[hitIdx] ?? "";
                    matches.push({
                        skill,
                        path: relative(skillRoot, file).split(sep).join("/"),
                        line: hitIdx + 1,
                        snippet: line.trim().slice(0, MAX_SNIPPET),
                        score: distinct,
                    });
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
        description:
            "Read a file from one of your skills (e.g. its SKILL.md or a reference " +
            "found via skill_search). Confined to your declared skills. Undeclared " +
            "skills and missing paths return a data variant.",
        inputSchema: SkillReadInputSchema,
        view: "none",
        describeCall: "none",
        execute: async ({ skill, path }): Promise<Result<SkillReadOutput, ToolError>> => {
            if (!allowed.has(skill)) {
                return ok({ status: "skill_not_declared" as const, skill });
            }
            const skillRoot = resolve(deps.skillsDir, skill);
            const target = resolve(skillRoot, path);
            if (target !== skillRoot && !target.startsWith(skillRoot + sep)) {
                return ok({ status: "out_of_scope" as const, skill, path });
            }
            let content: string;
            try {
                const s = await stat(target);
                if (!s.isFile()) return ok({ status: "not_found" as const, skill, path });
                if (s.size > MAX_FILE_BYTES) {
                    content = (await readFile(target)).subarray(0, MAX_FILE_BYTES).toString("utf8");
                    return ok({ status: "truncated" as const, skill, path, content, totalSize: s.size });
                }
                content = await readFile(target, "utf8");
            } catch {
                return ok({ status: "not_found" as const, skill, path });
            }
            return ok({ status: "ok" as const, skill, path, content });
        },
    });

    return { skillSearch, skillRead };
}

/** The `description` of the frontmatter of a `SKILL.md`, or `undefined` when the file or the field is absent. */
function skillDescription(skillsDir: string, skill: string): string | undefined {
    let text: string;
    try {
        text = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8");
    } catch {
        return undefined;
    }
    const lines = splitLines(text);
    if (lines[0]?.trim() !== "---") return undefined;
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    const field = lines.slice(1, end === -1 ? undefined : end).find((line) => line.startsWith("description:"));
    const value = field?.slice("description:".length).trim();
    return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * The first level of the skills of an agent: one entry for each declared skill, from the `description` of its
 * `SKILL.md`. The agent reads a `SKILL.md` and its references only when the work of the step needs them. The text
 * depends only on the declared skills and the skill files, thus it stays the same for each step of an agent type.
 */
export function skillIndex(skillsDir: string, skills: readonly string[]): string | undefined {
    const entries = skills.map((skill) => {
        const description = skillDescription(skillsDir, skill);
        return description === undefined ? `- \`${skill}\`` : `- \`${skill}\`: ${description}`;
    });
    if (entries.length === 0) return undefined;
    return [
        "## Your Skills",
        "",
        "`skill_read` reads a skill: its `SKILL.md` holds the method guidance, and its references hold the API of each library.",
        "",
        ...entries,
    ].join("\n");
}
