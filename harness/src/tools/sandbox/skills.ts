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

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";

/** Bounds — keep a search over a deep skill tree cheap and context-safe. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNIPPET = 240;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 25;
const TEXT_EXT = /\.(md|markdown|txt|py|r|R|json|ya?ml|csv|tsv)$/;

export interface SkillToolsDeps {
    /** Absolute path to the skills tree (one subdirectory per skill). */
    readonly skillsDir: string;
    /** The agent's declared skills (`meta.skills`) — the access allowlist. */
    readonly skills: readonly string[];
}

interface SkillMatch {
    readonly skill: string;
    readonly path: string;
    readonly line: number;
    readonly snippet: string;
    readonly score: number;
}

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
        } else if (TEXT_EXT.test(e.name)) {
            acc.push(full);
        }
    }
}

export function createSkillTools(deps: SkillToolsDeps) {
    const allowed = new Set(deps.skills);

    const skillSearch = defineTool({
        id: "skill_search",
        description:
            "Search your skills (method decision trees, API references, worked " +
            "examples) by keyword. Start here when picking a method or verifying an " +
            "API detail. Returns matching skill files with a line snippet — then " +
            "`skill_read` the file. No matches returns a data variant.",
        inputSchema: z.object({
            query: z.string().min(1).describe("Keywords to match (e.g. 'PyDESeq2 contrast syntax')."),
            topK: z.number().int().min(1).max(MAX_TOP_K).optional().describe(`Max results to return. Defaults to ${DEFAULT_TOP_K}.`),
        }),
        execute: async ({ query, topK }): Promise<Result<SkillSearchOutput, ToolError>> => {
            if (allowed.size === 0) {
                return ok({ status: "no_skills" as const });
            }
            const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
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

                    const lines = content.split(/\r?\n/);
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
        inputSchema: z.object({
            skill: z.string().min(1).describe("Skill name (one of your declared skills)."),
            path: z.string().min(1).describe("File path within the skill, e.g. 'SKILL.md' or 'references/pydeseq2-api.md'."),
        }),
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
