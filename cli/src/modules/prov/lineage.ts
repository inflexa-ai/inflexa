import { ok, err, type Result } from "neverthrow";
import {
    ProvActivity,
    ProvCommunication,
    ProvEntity,
    ProvGeneration,
    ProvUsage,
    PROV_ATTR_ACTIVITY,
    PROV_ATTR_ENTITY,
    PROV_ATTR_INFORMANT,
    PROV_ATTR_INFORMED,
    type AttrKey,
    type AttrValue,
    type ProvDocument,
    type ProvRecord,
} from "@inflexa-ai/tsprov";

import { dieOn, fail } from "../../lib/cli.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { findAnalysisForProv, loadDocument, PROV_UNIFY_OPTIONS } from "./document.ts";

// The lineage traversal: the read-side answer to "where did this file come from?" (and, with
// --forward, "what came from this file?"). Pure graph work over the SAME stored bytes `export`
// serializes — no schema change, no new storage, no new dependencies. The walk follows the
// generation/usage edges the builders write (`wasGeneratedBy(file, command|step)`,
// `used(activity, file)`, `wasInformedBy` for the activity spine); it deliberately ignores the
// coarse `wasDerivedFrom(file, analysis)` edge, which exists for generic PROV consumers, not for
// this walk. Everything below the CLI action is pure over an in-memory index so the traversal is
// unit-testable against documents built with the real builders.

/** Minimum hash-prefix length a lineage ref may resolve by — shorter prefixes are too collision-prone to guess on. */
const MIN_HASH_PREFIX = 6;

/**
 * Hard ceiling on walk depth even when `--depth` is unset ("unbounded"): the walk, the tree
 * renderer, and the JSON flattener all recurse one frame set per hop, so a pathologically long
 * chain would otherwise crash with a stack overflow instead of the marked truncation D4 promises
 * for every incomplete branch. A thousand generation hops is far beyond any real pipeline; hitting
 * it renders the same explicit `depth` marker as a user-set bound.
 */
const MAX_WALK_DEPTH = 1000;

/** How many known paths a not-found failure lists, so the user can orient without exporting the document. */
const NOT_FOUND_SAMPLE = 10;

/** A file entity's identity facts, as carried by its `inflexa:path`/`inflexa:hash` attributes (either may be unrecorded). */
export type LineageFileInfo = {
    /** The entity QName (`inflexa:file-…`) — the node key in the JSON graph. */
    qn: string;
    path: string | null;
    hash: string | null;
    /** The read-classification (`data`/`upstream`/`prior`/`step`), when an input record carried one. */
    source: string | null;
};

/**
 * One file node in a walk tree. `activities` is direction-dependent: backward, the (single by
 * construction) generating activity; forward, every activity that used this file. Empty with no
 * `marker` means a genuine terminal — no recorded generation (backward) or no recorded readers
 * (forward). A marker means the branch was NOT expanded here and says why.
 */
export type LineageFile = LineageFileInfo & {
    /** "revisit": already expanded earlier in this walk (diamond or cycle); "depth": cut by --depth. */
    marker?: "revisit" | "depth";
    activities: LineageActivity[];
};

/**
 * One activity node in a walk tree, carrying the context a reader needs to trust the answer:
 * command line + exit code, or the file tool, or the bare step — plus the owning step/run. `files`
 * is direction-dependent: backward, the files this activity read; forward, the files it generated.
 */
export type LineageActivity = {
    qn: string;
    kind: "command" | "file_tool" | "step" | "activity";
    command?: string;
    exitCode?: number;
    tool?: string;
    runId?: string;
    stepId?: string;
    files: LineageFile[];
};

/** Why a lineage ref failed to resolve — each variant maps to one actionable CLI message. */
export type LineageRefError =
    { type: "not_found"; knownPaths: string[] } | { type: "ambiguous_hash"; candidates: { path: string | null; hash: string | null }[] };

/** The element attributes the walk reads, normalized to plain values once at index time. */
type ElementAttrs = {
    types: string[];
    path?: string;
    hash?: string;
    source?: string;
    command?: string;
    exitCode?: number;
    tool?: string;
    runId?: string;
    stepId?: string;
};

/**
 * The one-pass graph index the resolution and both walks read. Built from the unified document's
 * typed records; every endpoint QName is normalized to its prefixed string form so the walk is
 * plain Map/string work with no tsprov objects in the hot path.
 */
export type LineageIndex = {
    /** entity QN → generating activity QNs (exactly one by the builders' construction; tolerated as a list). */
    generatedBy: Map<string, string[]>;
    /** activity QN → the entity QNs it generated. */
    generates: Map<string, string[]>;
    /** activity QN → the entity QNs it used. */
    uses: Map<string, string[]>;
    /** entity QN → the activity QNs that used it. */
    usedBy: Map<string, string[]>;
    /** informed activity QN → informant activity QNs (command → step, step → run). */
    informedBy: Map<string, string[]>;
    /** element QN → its normalized attributes. */
    attrs: Map<string, ElementAttrs>;
    /** Every `inflexa:file-*` entity, in document order — the resolution candidate set. */
    files: LineageFileInfo[];
};

/** An {@link AttrValue} as a plain string: a `Literal` unwraps to its value; QNames/identifiers stringify to prefixed form. */
function normalizeAttrValue(v: AttrValue): string {
    return typeof v === "object" && "value" in v && typeof v.value === "string" ? v.value : String(v);
}

/** First attribute value under `name` (an interned QName constant, or a `prefix:local` string), normalized via {@link normalizeAttrValue}. */
function attrString(rec: ProvRecord, name: AttrKey): string | undefined {
    const v: AttrValue | undefined = rec.getAttribute(name)[0];
    return v === undefined ? undefined : normalizeAttrValue(v);
}

/** Every attribute value under `name`, normalized via {@link normalizeAttrValue}. */
function attrStrings(rec: ProvRecord, name: AttrKey): string[] {
    return rec.getAttribute(name).map(normalizeAttrValue);
}

/** Append `value` under `key`, creating the bucket on first touch. */
function push(map: Map<string, string[]>, key: string | undefined, value: string | undefined): void {
    if (key === undefined || value === undefined) return;
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
}

/**
 * Build the traversal index in one pass over the document's typed records. The caller passes the
 * UNIFIED document (the stored column bytes already are, but unifying again is cheap defense —
 * duplicate records would otherwise double edges).
 */
export function buildLineageIndex(doc: ProvDocument): LineageIndex {
    const index: LineageIndex = {
        generatedBy: new Map(),
        generates: new Map(),
        uses: new Map(),
        usedBy: new Map(),
        informedBy: new Map(),
        attrs: new Map(),
        files: [],
    };

    for (const rec of doc.getRecords([ProvEntity, ProvActivity])) {
        const qn = rec.identifier?.toString();
        if (!qn) continue;
        // Read only the attributes the record's kind can carry — entities never have command
        // facts, activities never have file facts — so a large document pays no dead lookups.
        let attrs: ElementAttrs;
        if (rec instanceof ProvEntity) {
            attrs = {
                types: attrStrings(rec, "prov:type"),
                path: attrString(rec, "inflexa:path"),
                hash: attrString(rec, "inflexa:hash"),
                source: attrString(rec, "inflexa:source"),
            };
        } else {
            const exitCodeRaw = attrString(rec, "inflexa:exitCode");
            attrs = {
                types: attrStrings(rec, "prov:type"),
                command: attrString(rec, "inflexa:command"),
                exitCode: exitCodeRaw !== undefined && Number.isFinite(Number(exitCodeRaw)) ? Number(exitCodeRaw) : undefined,
                tool: attrString(rec, "inflexa:tool"),
                runId: attrString(rec, "inflexa:runId"),
                stepId: attrString(rec, "inflexa:stepId"),
            };
        }
        index.attrs.set(qn, attrs);
        // The file candidate set is keyed on the QName scheme, not on prov:type — an input-only
        // entity (a `used` read that no write registered) carries path/hash but no inflexa:File type.
        if (rec instanceof ProvEntity && qn.startsWith("inflexa:file-")) {
            index.files.push({ qn, path: attrs.path ?? null, hash: attrs.hash ?? null, source: attrs.source ?? null });
        }
    }

    for (const rec of doc.getRecords(ProvGeneration)) {
        const entity = attrString(rec, PROV_ATTR_ENTITY);
        const activity = attrString(rec, PROV_ATTR_ACTIVITY);
        push(index.generatedBy, entity, activity);
        push(index.generates, activity, entity);
    }
    for (const rec of doc.getRecords(ProvUsage)) {
        const activity = attrString(rec, PROV_ATTR_ACTIVITY);
        const entity = attrString(rec, PROV_ATTR_ENTITY);
        push(index.uses, activity, entity);
        push(index.usedBy, entity, activity);
    }
    for (const rec of doc.getRecords(ProvCommunication)) {
        push(index.informedBy, attrString(rec, PROV_ATTR_INFORMED), attrString(rec, PROV_ATTR_INFORMANT));
    }

    return index;
}

/**
 * Resolve a lineage ref against the file-entity candidate set: an exact path (ALL entities carrying
 * it — the same path re-written across runs is several genuinely distinct entities, surfaced, not
 * hidden), an exact hash, or an unambiguous hash prefix of ≥ {@link MIN_HASH_PREFIX} chars.
 * Ambiguity fails with the candidates; no match fails with a sample of the paths the document does
 * know, so the user can orient without exporting it.
 */
export function resolveFileRef(index: LineageIndex, ref: string): Result<LineageFileInfo[], LineageRefError> {
    const byPath = index.files.filter((f) => f.path === ref);
    if (byPath.length > 0) return ok(byPath);

    const byHash = index.files.filter((f) => f.hash === ref);
    if (byHash.length > 0) return ok(byHash);

    if (ref.length >= MIN_HASH_PREFIX) {
        const byPrefix = index.files.filter((f) => f.hash?.startsWith(ref));
        if (byPrefix.length === 1) return ok(byPrefix);
        if (byPrefix.length > 1) return err({ type: "ambiguous_hash", candidates: byPrefix.map((f) => ({ path: f.path, hash: f.hash })) });
    }

    const knownPaths = [...new Set(index.files.map((f) => f.path).filter((p): p is string => p !== null))].slice(0, NOT_FOUND_SAMPLE);
    return err({ type: "not_found", knownPaths });
}

/** The activity node for `qn`: kind from its `prov:type`, step/run from its own attributes or (for commands) its `wasInformedBy` step. */
function activityNode(index: LineageIndex, qn: string): Omit<LineageActivity, "files"> {
    const attrs = index.attrs.get(qn);
    const types = attrs?.types ?? [];
    const kind = types.includes("inflexa:Command")
        ? "command"
        : types.includes("inflexa:FileToolWrite")
          ? "file_tool"
          : types.includes("inflexa:Step")
            ? "step"
            : "activity";
    // A command has no run/step attributes of its own — its spine is the wasInformedBy edge to the
    // step activity, which carries both. A step (leaf-file generator) carries them directly.
    let runId = attrs?.runId;
    let stepId = attrs?.stepId;
    if (runId === undefined && stepId === undefined) {
        const stepQn = index.informedBy.get(qn)?.[0];
        const stepAttrs = stepQn !== undefined ? index.attrs.get(stepQn) : undefined;
        runId = stepAttrs?.runId;
        stepId = stepAttrs?.stepId;
    }
    return {
        qn,
        kind,
        ...(attrs?.command !== undefined ? { command: attrs.command } : {}),
        ...(attrs?.exitCode !== undefined ? { exitCode: attrs.exitCode } : {}),
        ...(attrs?.tool !== undefined ? { tool: attrs.tool } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(stepId !== undefined ? { stepId } : {}),
    };
}

/** The file-info facts for `qn`, read off the index (an unknown QName still renders — with null facts). */
function fileInfo(index: LineageIndex, qn: string): LineageFileInfo {
    const attrs = index.attrs.get(qn);
    return { qn, path: attrs?.path ?? null, hash: attrs?.hash ?? null, source: attrs?.source ?? null };
}

/**
 * Walk one file entity's lineage. Backward (`forward: false`): entity → its generating activity →
 * that activity's `used` entities, recursing — "what produced this, transitively". Forward: entity
 * → the activities that used it → the entities those generated — "what was derived from this".
 *
 * The visited set spans the WHOLE walk (not one branch): each entity expands once, and any
 * re-encounter — a diamond, or the real 1-cycle a write-then-self-read command records — renders
 * as an explicit `revisit` marker. A `--depth` cutoff renders a `depth` marker — as does the
 * {@link MAX_WALK_DEPTH} safety ceiling that stands in for "unbounded", so a pathological chain
 * truncates visibly instead of overflowing the stack. Neither ever looks like a completed leaf,
 * because a lineage tool must never present a truncated branch as a full answer. Depth-cut
 * entities are deliberately NOT added to `visited`, so a shallower re-encounter elsewhere can
 * still expand them.
 */
export function walkLineage(index: LineageIndex, rootQn: string, opts: { forward: boolean; depth?: number }): LineageFile {
    const visited = new Set<string>();
    const step = (qn: string, remaining: number): LineageFile => {
        const info = fileInfo(index, qn);
        if (visited.has(qn)) return { ...info, marker: "revisit", activities: [] };
        if (remaining <= 0) return { ...info, marker: "depth", activities: [] };
        visited.add(qn);
        const activityQns = opts.forward ? (index.usedBy.get(qn) ?? []) : (index.generatedBy.get(qn) ?? []);
        const activities = activityQns.map((aqn): LineageActivity => {
            const fileQns = opts.forward ? (index.generates.get(aqn) ?? []) : (index.uses.get(aqn) ?? []);
            return { ...activityNode(index, aqn), files: fileQns.map((fq) => step(fq, remaining - 1)) };
        });
        return { ...info, activities };
    };
    return step(rootQn, Math.min(opts.depth ?? MAX_WALK_DEPTH, MAX_WALK_DEPTH));
}

/** `hash` shortened for tree display — full hashes are for `--format json` and exact addressing. */
function shortHash(hash: string | null): string {
    return hash === null ? "?" : hash.slice(0, 12);
}

/** One human line for a file node: path (hash), plus its source classification and any marker. */
function fileLine(file: LineageFile): string {
    const name = file.path ?? file.qn;
    const bits = [`(hash ${shortHash(file.hash)}`];
    if (file.source !== null) bits.push(`, source ${file.source}`);
    bits.push(")");
    const marker = file.marker === "revisit" ? "  [already shown above]" : file.marker === "depth" ? "  [depth limit]" : "";
    return `${name}  ${bits.join("")}${marker}`;
}

/**
 * One human line for an activity node: what ran, and where (step, run). A STEP activity is marked
 * `(step-grain)`: its edges are recorded against the step, not the individual file — a step's
 * step-level reads and its leaf-file generations connect through step membership, an honest
 * upper bound, not the per-file fact a command edge states. The label keeps the two grains
 * visually distinct so a coarse connection is never mistaken for a fine one.
 */
function activityLine(activity: LineageActivity, forward: boolean): string {
    const verb = forward ? "used by" : "generated by";
    const what =
        activity.kind === "command"
            ? `${activity.command ?? "command"}${activity.exitCode !== undefined ? ` (exit ${activity.exitCode})` : ""}`
            : activity.kind === "file_tool"
              ? `${activity.tool ?? "file tool"} (file tool)`
              : activity.kind === "step"
                ? "step (step-grain)"
                : activity.qn;
    const where = activity.runId !== undefined || activity.stepId !== undefined ? ` — step ${activity.stepId ?? "?"}, run ${activity.runId ?? "?"}` : "";
    return `${verb}: ${what}${where}`;
}

/**
 * Render walk trees for humans: one lineage per resolved entity, each activity beneath its file
 * and each input/output file indented beneath its activity. An expanded file with no activities is
 * labeled a terminal ("no recorded …") rather than left bare — absence of recorded inputs must
 * never read as certainty that none existed (tool reads are a known recording gap).
 */
export function formatTree(roots: LineageFile[], forward: boolean): string {
    const lines: string[] = [];
    const renderFile = (file: LineageFile, prefix: string, isLast: boolean, isRoot: boolean): void => {
        if (isRoot) lines.push(fileLine(file));
        else lines.push(`${prefix}${isLast ? "└─ " : "├─ "}${fileLine(file)}`);
        const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
        if (file.marker !== undefined) return;
        if (file.activities.length === 0) {
            lines.push(`${childPrefix}└─ ${forward ? "no recorded readers" : "no recorded generation — terminal input"}`);
            return;
        }
        for (const [i, activity] of file.activities.entries()) {
            const lastActivity = i === file.activities.length - 1;
            lines.push(`${childPrefix}${lastActivity ? "└─ " : "├─ "}${activityLine(activity, forward)}`);
            const filePrefix = `${childPrefix}${lastActivity ? "   " : "│  "}`;
            if (activity.files.length === 0) {
                // A step's absence claim is scoped to its own grain: commands inside the step may
                // well have recorded reads/outputs of their own — those are attributed to them.
                const label =
                    activity.kind === "step"
                        ? forward
                            ? "no step-grain outputs (command outputs are attributed to their commands)"
                            : "no step-grain inputs"
                        : forward
                          ? "no recorded readers of this output"
                          : "no recorded inputs";
                lines.push(`${filePrefix}└─ ${label}`);
                continue;
            }
            for (const [j, child] of activity.files.entries()) {
                renderFile(child, filePrefix, j === activity.files.length - 1, false);
            }
        }
    };
    for (const [i, root] of roots.entries()) {
        if (i > 0) lines.push("");
        renderFile(root, "", true, true);
    }
    return lines.join("\n");
}

/** A node of the flat JSON graph — kind-discriminated, carrying only the facts that kind has. */
export type LineageJsonNode =
    | { kind: "file"; path: string | null; hash: string | null; source: string | null; truncated?: true }
    | { kind: "command"; command?: string; exitCode?: number; runId?: string; stepId?: string }
    | { kind: "file_tool"; tool?: string; runId?: string; stepId?: string }
    | { kind: "step" | "activity"; runId?: string; stepId?: string };

/** The flat JSON graph: direction-independent nodes + edges in PROV semantics, plus the walk's roots. */
export type LineageJson = {
    roots: string[];
    nodes: Record<string, LineageJsonNode>;
    edges: { from: string; to: string; kind: "wasGeneratedBy" | "used" }[];
};

/**
 * Flatten walk trees into `{ roots, nodes, edges }`. Nodes are keyed by QName, so revisit markers
 * dedup away naturally (the expansion exists once); only a `depth` cutoff survives as
 * `truncated: true` — a script must be able to tell "walk ended here" from "no further inputs".
 * Edges are emitted in PROV semantics regardless of walk direction: `wasGeneratedBy` is always
 * entity → activity and `used` is always activity → entity, so consumers re-derive either
 * direction from one representation.
 */
export function formatJson(roots: LineageFile[], forward: boolean): LineageJson {
    const nodes: Record<string, LineageJsonNode> = {};
    const edgeKeys = new Set<string>();
    const edges: LineageJson["edges"] = [];
    const addEdge = (from: string, to: string, kind: "wasGeneratedBy" | "used"): void => {
        const key = `${kind}|${from}|${to}`;
        if (edgeKeys.has(key)) return;
        edgeKeys.add(key);
        edges.push({ from, to, kind });
    };
    const addFile = (file: LineageFile): void => {
        // A revisit re-encounters an already-expanded node; a depth-cut node may also be present
        // expanded elsewhere (shallower path) — only mark truncated when no expansion recorded it.
        if (!(file.qn in nodes)) {
            nodes[file.qn] = {
                kind: "file",
                path: file.path,
                hash: file.hash,
                source: file.source,
                ...(file.marker === "depth" ? { truncated: true as const } : {}),
            };
        } else if (file.marker === undefined && "truncated" in nodes[file.qn]!) {
            nodes[file.qn] = { kind: "file", path: file.path, hash: file.hash, source: file.source };
        }
        for (const activity of file.activities) {
            if (!(activity.qn in nodes)) {
                const { qn: _qn, files: _files, kind, ...facts } = activity;
                nodes[activity.qn] = { kind, ...facts } as LineageJsonNode;
            }
            if (forward) addEdge(activity.qn, file.qn, "used");
            else addEdge(file.qn, activity.qn, "wasGeneratedBy");
            for (const child of activity.files) {
                if (forward) addEdge(child.qn, activity.qn, "wasGeneratedBy");
                else addEdge(activity.qn, child.qn, "used");
                addFile(child);
            }
        }
    };
    for (const root of roots) addFile(root);
    return { roots: roots.map((r) => r.qn), nodes, edges };
}

/** The validated `prov lineage` options, parsed at the CLI boundary. */
type LineageOptions = { forward: boolean; depth?: number; format: "tree" | "json" };

/** Validate the raw commander options; any invalid flag fails with the accepted values. */
function parseOptions(opts: { forward?: boolean; depth?: string; format?: string }): LineageOptions {
    const format = (opts.format ?? "tree").toLowerCase();
    if (format !== "tree" && format !== "json") fail(`Unknown format "${opts.format}". Use "tree" or "json".`);
    let depth: number | undefined;
    if (opts.depth !== undefined) {
        depth = Number(opts.depth);
        if (!Number.isInteger(depth) || depth < 1) fail(`--depth must be a positive integer, got "${opts.depth}".`);
    }
    return { forward: opts.forward ?? false, depth, format };
}

/**
 * `inflexa prov lineage <analysis> <file> [--forward] [--depth n] [--format tree|json]` — resolve
 * the file ref in the analysis's stored provenance document and print its lineage. Reads the same
 * stored bytes `export` serializes; an analysis with no recorded provenance fails with an
 * actionable message rather than an empty walk.
 */
export function runProvLineage(analysisRef: string, fileRef: string, rawOpts: { forward?: boolean; depth?: string; format?: string }): void {
    const opts = parseOptions(rawOpts);

    const analysis = findAnalysisForProv(analysisRef).match((a) => a, dieOn("Failed to resolve analysis"));
    if (!analysis) fail(`No analysis found matching "${analysisRef}".`);

    const stored = getAnalysisProvenance(analysis.id).match((s) => s, dieOn("Failed to read provenance"));
    if (stored === null) fail(`No provenance recorded for "${analysis.name}" yet — run an analysis first.`);

    const doc = loadDocument(analysis, stored).match((d) => d, dieOn("Stored provenance is corrupt"));
    const index = buildLineageIndex(doc.unified(PROV_UNIFY_OPTIONS));

    const rootInfos = resolveFileRef(index, fileRef).match(
        (infos) => infos,
        (e) => {
            if (e.type === "ambiguous_hash") {
                const list = e.candidates.map((c) => `  ${c.hash ?? "?"}  ${c.path ?? "?"}`).join("\n");
                fail(`Hash prefix "${fileRef}" is ambiguous — candidates:\n${list}`);
            }
            const hint = e.knownPaths.length > 0 ? `\nKnown files include:\n${e.knownPaths.map((p) => `  ${p}`).join("\n")}` : "";
            fail(`No file matching "${fileRef}" in the provenance of "${analysis.name}".${hint}`);
        },
    );

    const roots = rootInfos.map((info) => walkLineage(index, info.qn, { forward: opts.forward, depth: opts.depth }));
    if (opts.format === "json") console.log(JSON.stringify(formatJson(roots, opts.forward), null, 2));
    else console.log(formatTree(roots, opts.forward));
}
