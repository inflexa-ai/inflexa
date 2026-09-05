/**
 * The snapshot store: one SQLite file per snapshot, read only at serve time.
 *
 * The build writes the tables from the validated tree. The service opens the
 * file read only and loads the rules, the methods, the templates, and the
 * modalities into memory at start, because the corpus is small and the rule
 * match runs over every rule. The FTS5 table over the rules exists for the
 * free-text path of a later phase and costs nothing here.
 */

import { Database } from "bun:sqlite";

import { canonicalize, claimId, contentDigest } from "./canonical.js";
import type { KnowledgeBase, Method, Modality, Rule, Source, Template, VocabularyTerm } from "./model.js";
import { SnapshotMetaSchema, type SnapshotMeta } from "./model.js";
import type { StoredRule } from "./engine/rules.js";

const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, doi TEXT, pmid TEXT, json TEXT NOT NULL);
CREATE TABLE methods (id TEXT PRIMARY KEY, label TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE rules (id TEXT PRIMARY KEY, claim TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, step_type TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE templates (id TEXT PRIMARY KEY, version TEXT NOT NULL, method TEXT NOT NULL, json TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE modalities (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE terms (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE VIRTUAL TABLE rules_fts USING fts5(id UNINDEXED, title, assertion);
`;

export interface BuildInput {
    readonly kb: KnowledgeBase;
    readonly date: string;
    readonly schemaVersion: string;
    readonly vocabularies: readonly string[];
    readonly toolDefinitionHash: string;
    readonly changelog?: string;
}

export interface BuildOutput {
    readonly meta: SnapshotMeta;
    readonly claims: ReadonlyMap<string, string>;
}

/** The content digest of the whole set: the canonical JSON of every record, in id order. */
export function snapshotDigest(kb: KnowledgeBase): string {
    const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
    return contentDigest({
        sources: byId(kb.sources),
        methods: byId(kb.methods),
        rules: byId(kb.rules),
        templates: byId(kb.templates),
        modalities: byId(kb.modalities),
        terms: byId(kb.terms),
    });
}

export function writeSnapshot(path: string, input: BuildInput): BuildOutput {
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = OFF");
    db.exec(DDL);
    const claims = new Map<string, string>();
    const digest = snapshotDigest(input.kb);
    const meta: SnapshotMeta = {
        date: input.date,
        digest,
        schema_version: input.schemaVersion,
        vocabularies: [...input.vocabularies],
        tool_definition_hash: input.toolDefinitionHash,
        ...(input.changelog ? { changelog: input.changelog } : {}),
        counts: {
            sources: input.kb.sources.length,
            methods: input.kb.methods.length,
            rules: input.kb.rules.length,
            templates: input.kb.templates.length,
            terms: input.kb.terms.length,
        },
    };
    const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES ($key, $value)");
    for (const [key, value] of Object.entries(meta)) insertMeta.run({ key, value: typeof value === "string" ? value : JSON.stringify(value) });

    const insertSource = db.prepare("INSERT INTO sources (id, doi, pmid, json) VALUES ($id, $doi, $pmid, $json)");
    for (const source of input.kb.sources) insertSource.run({ id: source.id, doi: source.doi ?? null, pmid: source.pmid ?? null, json: canonicalize(source) });

    const insertMethod = db.prepare("INSERT INTO methods (id, label, json) VALUES ($id, $label, $json)");
    for (const method of input.kb.methods) insertMethod.run({ id: method.id, label: method.label, json: canonicalize(method) });

    const insertRule = db.prepare("INSERT INTO rules (id, claim, digest, step_type, severity, status, json) VALUES ($id, $claim, $digest, $step, $severity, $status, $json)");
    const insertFts = db.prepare("INSERT INTO rules_fts (id, title, assertion) VALUES ($id, $title, $assertion)");
    for (const rule of input.kb.rules) {
        const ruleDigest = contentDigest(rule);
        const claim = claimId(rule.id, ruleDigest);
        claims.set(rule.id, claim);
        insertRule.run({ id: rule.id, claim, digest: ruleDigest, step: rule.action.step_type, severity: rule.severity, status: rule.status, json: canonicalize(rule) });
        insertFts.run({ id: rule.id, title: rule.title, assertion: rule.assertion });
    }

    const insertTemplate = db.prepare("INSERT INTO templates (id, version, method, json, body) VALUES ($id, $version, $method, $json, $body)");
    for (const template of input.kb.templates) {
        const { body, ...record } = template;
        insertTemplate.run({ id: template.id, version: template.version, method: template.method, json: canonicalize(record), body });
    }

    const insertModality = db.prepare("INSERT INTO modalities (id, json) VALUES ($id, $json)");
    for (const modality of input.kb.modalities) insertModality.run({ id: modality.id, json: canonicalize(modality) });

    const insertTerm = db.prepare("INSERT INTO terms (id, json) VALUES ($id, $json)");
    for (const term of input.kb.terms) insertTerm.run({ id: term.id, json: canonicalize(term) });

    db.close();
    return { meta, claims };
}

export interface LoadedSnapshot {
    readonly meta: SnapshotMeta;
    readonly rules: readonly StoredRule[];
    readonly rulesByClaim: ReadonlyMap<string, StoredRule>;
    readonly methods: ReadonlyMap<string, Method>;
    readonly templates: ReadonlyMap<string, Template>;
    readonly templateBodies: ReadonlyMap<string, string>;
    readonly modalities: ReadonlyMap<string, Modality>;
    readonly sources: ReadonlyMap<string, Source>;
    readonly terms: readonly VocabularyTerm[];
}

export function openSnapshot(path: string): LoadedSnapshot {
    const db = new Database(path, { readonly: true, strict: true });
    try {
        const metaRows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all();
        const rawMeta: Record<string, unknown> = {};
        for (const row of metaRows) {
            rawMeta[row.key] = row.key === "vocabularies" || row.key === "counts" ? JSON.parse(row.value) : row.value;
        }
        const meta = SnapshotMetaSchema.parse(rawMeta);

        const rules = db
            .query<{ claim: string; digest: string; json: string }, []>("SELECT claim, digest, json FROM rules ORDER BY id")
            .all()
            .map((row) => ({ rule: JSON.parse(row.json) as Rule, claim: row.claim, digest: row.digest }));
        const methods = new Map(db.query<{ json: string }, []>("SELECT json FROM methods").all().map((row) => JSON.parse(row.json) as Method).map((method) => [method.id, method]));
        const templateRows = db.query<{ json: string; body: string }, []>("SELECT json, body FROM templates").all();
        const templates = new Map(templateRows.map((row) => JSON.parse(row.json) as Template).map((template) => [template.id, template]));
        const templateBodies = new Map(templateRows.map((row) => [(JSON.parse(row.json) as Template).id, row.body]));
        const modalities = new Map(db.query<{ json: string }, []>("SELECT json FROM modalities").all().map((row) => JSON.parse(row.json) as Modality).map((modality) => [modality.id, modality]));
        const sources = new Map(db.query<{ json: string }, []>("SELECT json FROM sources").all().map((row) => JSON.parse(row.json) as Source).map((source) => [source.id, source]));
        const terms = db.query<{ json: string }, []>("SELECT json FROM terms").all().map((row) => JSON.parse(row.json) as VocabularyTerm);
        return {
            meta,
            rules,
            rulesByClaim: new Map(rules.map((stored) => [stored.claim, stored])),
            methods,
            templates,
            templateBodies,
            modalities,
            sources,
            terms,
        };
    } finally {
        db.close();
    }
}
