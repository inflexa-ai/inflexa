/**
 * Read the curated tree into the typed knowledge base.
 *
 * Layout, under `kb/`:
 *   sources/*.yaml         a list of Source records per file
 *   methods/*.yaml         one Method per file
 *   rules/*.yaml           one Rule per file, named by its id
 *   templates/<id>/template.yaml plus the body file that it names
 *   modalities/*.yaml      one Modality per file
 *   vocab/*.yaml           a list of VocabularyTerm records per file
 *
 * The loader parses and validates each file with the Zod mirror, and it reports
 * every failure with the path, not only the first. Referential checks are the
 * work of `validate.ts`, after the load.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";

import { MethodSchema, ModalitySchema, RuleSchema, SourceSchema, TemplateSchema, VocabularyTermSchema, type KnowledgeBase } from "../model.js";

export interface LoadIssue {
    readonly path: string;
    readonly message: string;
}

export type LoadResult = { readonly ok: true; readonly kb: KnowledgeBase } | { readonly ok: false; readonly issues: readonly LoadIssue[] };

async function yamlFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
        .map((entry) => join(dir, entry.name))
        .sort();
}

function issuesOf(path: string, error: z.ZodError): LoadIssue[] {
    return error.issues.map((issue) => ({ path, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` }));
}

class YamlParseError extends Error {
    constructor(
        readonly path: string,
        message: string,
    ) {
        super(message);
    }
}

async function parseYaml(path: string): Promise<unknown> {
    const text = await Bun.file(path).text();
    try {
        return Bun.YAML.parse(text);
    } catch (error) {
        throw new YamlParseError(path, error instanceof Error ? error.message : String(error));
    }
}

async function loadOnePerFile<S extends z.ZodType>(dir: string, schema: S, issues: LoadIssue[]): Promise<z.infer<S>[]> {
    const out: z.infer<S>[] = [];
    for (const path of await yamlFiles(dir)) {
        const parsed = schema.safeParse(await parseYaml(path));
        if (parsed.success) out.push(parsed.data);
        else issues.push(...issuesOf(path, parsed.error));
    }
    return out;
}

async function loadListPerFile<S extends z.ZodType>(dir: string, schema: S, issues: LoadIssue[]): Promise<z.infer<S>[]> {
    const out: z.infer<S>[] = [];
    for (const path of await yamlFiles(dir)) {
        const raw = await parseYaml(path);
        if (!Array.isArray(raw)) {
            issues.push({ path, message: "expected a list of records" });
            continue;
        }
        raw.forEach((item, index) => {
            const parsed = schema.safeParse(item);
            if (parsed.success) out.push(parsed.data);
            else issues.push(...issuesOf(`${path}[${index}]`, parsed.error));
        });
    }
    return out;
}

export async function loadKnowledgeBase(root: string): Promise<LoadResult> {
    try {
        return await loadTree(root);
    } catch (error) {
        if (error instanceof YamlParseError) return { ok: false, issues: [{ path: error.path, message: `YAML parse error: ${error.message}` }] };
        throw error;
    }
}

async function loadTree(root: string): Promise<LoadResult> {
    const issues: LoadIssue[] = [];
    const sources = await loadListPerFile(join(root, "sources"), SourceSchema, issues);
    const methods = await loadOnePerFile(join(root, "methods"), MethodSchema, issues);
    const rules = await loadOnePerFile(join(root, "rules"), RuleSchema, issues);
    const modalities = await loadOnePerFile(join(root, "modalities"), ModalitySchema, issues);
    const terms = await loadListPerFile(join(root, "vocab"), VocabularyTermSchema, issues);

    const templates: KnowledgeBase["templates"][number][] = [];
    const templateDirs = await readdir(join(root, "templates"), { withFileTypes: true }).catch(() => []);
    for (const entry of templateDirs.filter((dir) => dir.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const dir = join(root, "templates", entry.name);
        const manifest = join(dir, "template.yaml");
        if (!(await Bun.file(manifest).exists())) {
            issues.push({ path: dir, message: "a template directory needs a template.yaml" });
            continue;
        }
        const parsed = TemplateSchema.safeParse(await parseYaml(manifest));
        if (!parsed.success) {
            issues.push(...issuesOf(manifest, parsed.error));
            continue;
        }
        if (parsed.data.id !== entry.name) issues.push({ path: manifest, message: `the id ${parsed.data.id} differs from the directory name ${entry.name}` });
        const bodyFile = Bun.file(join(dir, parsed.data.body_file));
        if (!(await bodyFile.exists())) {
            issues.push({ path: manifest, message: `the body file ${parsed.data.body_file} does not exist` });
            continue;
        }
        templates.push({ ...parsed.data, body: await bodyFile.text() });
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, kb: { sources, methods, rules, templates, modalities, terms } };
}
