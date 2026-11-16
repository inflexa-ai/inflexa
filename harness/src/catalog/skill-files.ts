/**
 * Skills on disk: the frontmatter of a `SKILL.md`, and a `SkillStore` over skill roots. This is the local
 * realization of the store, which a host that keeps its skills in directories gives to the catalog. The harness itself
 * never takes a skills directory.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { load } from "js-yaml";
import { z } from "zod";

import type { SkillInfo, SkillStore } from "./types.js";

/** The file-name extensions a skill may carry text in. */
const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".py", ".r", ".R", ".json", ".yaml", ".yml", ".csv", ".tsv"];

const SkillFrontmatterSchema = z.looseObject({
    name: z.string().min(1),
    description: z.string().min(1),
});

export type SkillFrontmatterProblem = "no_frontmatter" | "invalid_yaml" | "missing_name_or_description";

/** The `name` and the `description` of a `SKILL.md`. The frontmatter is YAML, thus a block, quoted or multi-line value reads whole. */
export function parseSkillFrontmatter(
    text: string,
): { readonly ok: true; readonly skill: SkillInfo } | { readonly ok: false; readonly problem: SkillFrontmatterProblem } {
    const normalized = text.replaceAll("\r\n", "\n");
    if (!normalized.startsWith("---\n")) return { ok: false, problem: "no_frontmatter" };
    const end = normalized.indexOf("\n---", 3);
    if (end === -1) return { ok: false, problem: "no_frontmatter" };
    let raw: unknown;
    try {
        raw = load(normalized.slice(4, end));
    } catch {
        return { ok: false, problem: "invalid_yaml" };
    }
    const parsed = SkillFrontmatterSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, problem: "missing_name_or_description" };
    return { ok: true, skill: { name: parsed.data.name, description: parsed.data.description.trim() } };
}

export type SkillRootProblem =
    | { readonly kind: "frontmatter"; readonly directory: string; readonly problem: SkillFrontmatterProblem }
    | { readonly kind: "name_mismatch"; readonly directory: string; readonly name: string }
    | { readonly kind: "name_taken"; readonly directory: string; readonly name: string; readonly by: string };

export type ScannedSkill = SkillInfo & { readonly directory: string };

/**
 * The skills of each root, in order. A skill of an earlier root keeps its name, thus a later root cannot replace a
 * built-in skill. A directory with no valid frontmatter, or whose `name` differs from its directory name, is a problem
 * and not a skill.
 */
export async function scanSkillRoots(
    roots: readonly string[],
): Promise<{ readonly skills: readonly ScannedSkill[]; readonly problems: readonly SkillRootProblem[] }> {
    const skills = new Map<string, ScannedSkill>();
    const problems: SkillRootProblem[] = [];
    for (const root of roots) {
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
            const directory = join(root, entry.name);
            let text: string;
            try {
                text = await readFile(join(directory, "SKILL.md"), "utf8");
            } catch {
                continue;
            }
            const parsed = parseSkillFrontmatter(text);
            if (!parsed.ok) {
                problems.push({ kind: "frontmatter", directory, problem: parsed.problem });
                continue;
            }
            const { name, description } = parsed.skill;
            if (name !== entry.name) {
                problems.push({ kind: "name_mismatch", directory, name });
                continue;
            }
            const taken = skills.get(name);
            if (taken !== undefined) {
                problems.push({ kind: "name_taken", directory, name, by: taken.directory });
                continue;
            }
            skills.set(name, { name, description, directory });
        }
    }
    return { skills: [...skills.values()], problems };
}

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

/** A file of a skill directory, or `undefined` for a path that leaves the directory. */
function insideSkill(directory: string, path: string): string | undefined {
    const target = resolve(directory, path);
    return target.startsWith(directory + sep) ? target : undefined;
}

/** How long one scan of the roots serves the calls of the store. A search reads many files, and each read needs the directory of its skill. */
const SCAN_REUSE_MS = 2_000;

/** A `SkillStore` over skill roots. The store scans the roots again after a short reuse window, thus a new skill appears with no restart. */
export function createDirectorySkillStore(roots: readonly string[]): SkillStore {
    let scan: { readonly at: number; readonly skills: Promise<ReadonlyMap<string, ScannedSkill>> } | undefined;
    const scanned = (): Promise<ReadonlyMap<string, ScannedSkill>> => {
        const now = Date.now();
        if (scan === undefined || now - scan.at > SCAN_REUSE_MS) {
            scan = { at: now, skills: scanSkillRoots(roots).then((result) => new Map(result.skills.map((skill) => [skill.name, skill]))) };
        }
        return scan.skills;
    };
    const directoryOf = async (skill: string): Promise<string | undefined> => (await scanned()).get(skill)?.directory;
    return {
        list: async () => [...(await scanned()).values()].map(({ name, description }) => ({ name, description })),
        files: async (skill) => {
            const directory = await directoryOf(skill);
            if (directory === undefined) return [];
            const files: string[] = [];
            await collectTextFiles(directory, files);
            return files.map((file) => relative(directory, file).split(sep).join("/")).sort();
        },
        read: async (skill, path) => {
            const directory = await directoryOf(skill);
            const target = directory === undefined ? undefined : insideSkill(directory, path);
            if (target === undefined) return undefined;
            try {
                return await readFile(target, "utf8");
            } catch {
                return undefined;
            }
        },
        size: async (skill, path) => {
            const directory = await directoryOf(skill);
            const target = directory === undefined ? undefined : insideSkill(directory, path);
            if (target === undefined) return undefined;
            try {
                const info = await stat(target);
                return info.isFile() ? info.size : undefined;
            } catch {
                return undefined;
            }
        },
    };
}
