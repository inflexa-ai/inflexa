import { ok, err, type Result } from "neverthrow";
import { ProvActivity, ProvCommunication, ProvEntity, ProvGeneration, ProvUsage, type AttrKey, type ProvDocument, type ProvRecord } from "@inflexa-ai/tsprov";
import {
    lineage,
    MAX_WALK_DEPTH,
    normalizeAttrValue,
    provToGraph,
    resolve,
    resolveUnique,
    toFlatGraph,
    type LineageResult,
    type ProvGraph,
    type Resolution,
} from "@inflexa-ai/tsprov/graph";

import { dieOn, fail } from "../../lib/cli.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { loadDocument, PROV_UNIFY_OPTIONS } from "./document.ts";
import { requireAnalysisForProv } from "./prov.ts";

// The lineage traversal: the read-side answer to "where did this file come from?" (and, with
// --forward, "what came from this file?"). It reads the SAME stored bytes `export` serializes and
// leans on tsprov's graph engine for the mechanical graph work — a directional, cycle-safe, bounded
// walk over the generation/usage edges — while this file owns everything that is inflexa's product
// vocabulary: the `inflexa:*` attributes, the kind classification, step-grain labeling, scoped
// absence claims, and the tree/JSON rendering.
//
// The walk traverses ONLY generation and usage edges. The document also carries a coarse
// `wasDerivedFrom(file, analysis)` edge (for generic PROV consumers) and a `wasInformedBy` spine
// (command → step → run); following either would pollute a file's lineage — derivation with a link
// to the whole analysis, communication with every command's step and run activity. The run/step
// spine is instead read as a LABEL off the communication adjacency (see `activityMeta`), never
// walked. Everything below the CLI action is pure over a `ProvGraph`, so the traversal stays
// unit-testable against documents built with the real builders.

/** Minimum hash-prefix length a lineage ref may resolve by — shorter prefixes are too collision-prone to guess on. */
const MIN_HASH_PREFIX = 6;

/** How many known paths a not-found failure lists, so the user can orient without exporting the document. */
const NOT_FOUND_SAMPLE = 10;

/**
 * How many candidates an ambiguous search failure carries: enough to pick a copyable exact ref
 * from, few enough to stay readable — the error's `total` says how many more matched.
 */
const SEARCH_CANDIDATE_CAP = 10;

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

/**
 * What a lineage ref resolved to: one or more file entities (an exact path re-written across runs
 * is several genuinely distinct entities, each walked), or a single command/file-tool activity
 * found by search. Kind-homogeneous by construction — a search that would mix kinds fails as
 * ambiguous instead of walking a surprise forest.
 */
export type LineageRoots = { kind: "files"; infos: LineageFileInfo[] } | { kind: "activity"; qn: string };

/**
 * One kind-tagged candidate in an ambiguous search failure. An activity carries its pre-composed
 * fact line (command + exit code or tool, with step and run) so the failure listing describes an
 * activity in exactly the words the tree would use.
 */
export type LineageSearchCandidate = { kind: "file"; path: string | null; hash: string | null } | { kind: "activity"; line: string };

/** Why a lineage ref failed to resolve — each variant maps to one actionable CLI message. */
export type LineageRefError =
    | { type: "not_found"; knownPaths: string[] }
    | { type: "ambiguous_hash"; candidates: { path: string | null; hash: string | null }[] }
    | {
          type: "ambiguous_search";
          /** At most {@link SEARCH_CANDIDATE_CAP} candidates, in path → command → tool probe order. */
          candidates: LineageSearchCandidate[];
          /** The full match count — the CLI renders the `+ n more` tail from the difference. */
          total: number;
      };

/**
 * The lexical/primary string form of a record's first value under `name`, or `undefined` when the
 * attribute is absent. The library's normalization returns EVERY matchable form (a QName yields its
 * URI and its `prefix:local` display form); the display facts read here are single-valued literals,
 * so element `[0]` is the value to show. Kind classification, which reads the QName-valued
 * `prov:type`, deliberately does NOT go through this helper — it needs the full form list.
 */
function firstAttr(rec: ProvRecord, name: AttrKey): string | undefined {
    const value = rec.getAttribute(name)[0];
    return value === undefined ? undefined : normalizeAttrValue(value)[0];
}

/** A resolved entity record as a {@link LineageFileInfo} — its prefixed QName plus the identity facts it carries. */
function toFileInfo(rec: ProvRecord): LineageFileInfo {
    return {
        qn: rec.identifier?.toString() ?? "",
        path: firstAttr(rec, "inflexa:path") ?? null,
        hash: firstAttr(rec, "inflexa:hash") ?? null,
        source: firstAttr(rec, "inflexa:source") ?? null,
    };
}

/**
 * Every pathed entity in the document — whatever its QName scheme — carrying the facts the
 * not-found sample needs. The predicate is the attribute itself, not an identifier convention,
 * because a freshly-profiled analysis may carry ONLY `input-*` entities and the orientation hint
 * must still name their paths (the substring tier already matches these same entities). The
 * attribute lookup cannot throw here: every document this module loads declares the `inflexa`
 * namespace, so the name always resolves.
 */
function fileEntities(graph: ProvGraph): LineageFileInfo[] {
    const outcome = resolve(graph, { type: ProvEntity, where: (r) => r.getAttribute("inflexa:path").length > 0 });
    return outcome.kind === "matched" ? outcome.records.map(toFileInfo) : [];
}

/**
 * Resolve a lineage ref through five tiers: exact `inflexa:path` (ALL entities carrying it — the
 * same path re-written across runs is several genuinely distinct entities, surfaced, not hidden),
 * exact `inflexa:hash`, an unambiguous hash prefix of ≥ {@link MIN_HASH_PREFIX} chars, a
 * case-sensitive substring search over recorded paths, command lines, and tool names, and — when
 * even the search finds nothing — an exact-identifier match against entity and activity QNames,
 * accepting the full prefixed form (`inflexa:input-…`) or the bare localpart (`input-…`): the
 * token a user copies straight out of the exported PROV. Hashes are deliberately never
 * substring-searched — hash addressing stays exact-or-prefix, git-style; a substring hit inside a
 * digest is noise, never intent — and identifier matching is exact only, placed last so it can
 * never shadow an attribute tier. A single search match resolves (an activity match roots the
 * walk there); matches that are all entities of ONE path collapse to that path's entity set — the
 * same multiplicity the exact-path tier surfaces; any other mix fails with kind-tagged candidates
 * rather than walking a surprise forest. No match at any tier fails with a sample of the paths
 * the document does know. Directory-style refs carry no special semantics: they land in the
 * candidate or not-found failure like any string.
 */
export function resolveLineageRef(graph: ProvGraph, ref: string): Result<LineageRoots, LineageRefError> {
    const byPath = resolve(graph, { type: ProvEntity, attributes: [{ name: "inflexa:path", equals: ref }] });
    if (byPath.kind === "matched") return ok({ kind: "files", infos: byPath.records.map(toFileInfo) });

    const byHash = resolve(graph, { type: ProvEntity, attributes: [{ name: "inflexa:hash", equals: ref }] });
    if (byHash.kind === "matched") return ok({ kind: "files", infos: byHash.records.map(toFileInfo) });

    if (ref.length >= MIN_HASH_PREFIX) {
        const byPrefix = resolveUnique(graph, { type: ProvEntity, attributes: [{ name: "inflexa:hash", startsWith: ref }] });
        if (byPrefix.kind === "resolved") return ok({ kind: "files", infos: [toFileInfo(byPrefix.record)] });
        if (byPrefix.kind === "ambiguous") {
            return err({
                type: "ambiguous_hash",
                candidates: byPrefix.candidates.map((c) => ({ path: firstAttr(c, "inflexa:path") ?? null, hash: firstAttr(c, "inflexa:hash") ?? null })),
            });
        }
    }

    // Shared by every ambiguous outcome below, so the substring and identifier tiers can never
    // drift on how a candidate is described.
    const toCandidates = (records: readonly ProvRecord[]): LineageSearchCandidate[] =>
        records.slice(0, SEARCH_CANDIDATE_CAP).map((rec): LineageSearchCandidate => {
            if (rec instanceof ProvEntity) {
                const info = toFileInfo(rec);
                return { kind: "file", path: info.path, hash: info.hash };
            }
            return { kind: "activity", line: activityFacts(activityMeta(graph, rec.identifier?.uri ?? "")) };
        });

    // Search tier: the ref as a substring over the three searchable targets, in a fixed probe
    // order so candidate listings are deterministic. Entities and activities are disjoint record
    // kinds, and no activity carries both a command and a tool, but the URI dedup guards the
    // accounting anyway — a double-counted match would inflate `total`.
    const matches: ProvRecord[] = [];
    const seen = new Set<string>();
    const collect = (outcome: Resolution): void => {
        if (outcome.kind !== "matched") return;
        for (const rec of outcome.records) {
            const uri = rec.identifier?.uri;
            if (uri === undefined || seen.has(uri)) continue;
            seen.add(uri);
            matches.push(rec);
        }
    };
    collect(resolve(graph, { type: ProvEntity, attributes: [{ name: "inflexa:path", includes: ref }] }));
    collect(resolve(graph, { type: ProvActivity, attributes: [{ name: "inflexa:command", includes: ref }] }));
    collect(resolve(graph, { type: ProvActivity, attributes: [{ name: "inflexa:tool", includes: ref }] }));

    if (matches.length > 0) {
        const entities = matches.filter((rec) => rec instanceof ProvEntity);
        if (entities.length === matches.length) {
            // Every entity carrying a path P also contains any substring of P, so an all-one-path
            // match set already IS that path's full entity set — no second query needed.
            const paths = new Set(entities.map((rec) => firstAttr(rec, "inflexa:path")));
            if (paths.size === 1) return ok({ kind: "files", infos: entities.map(toFileInfo) });
        }
        if (matches.length === 1) {
            // A lone match here is always an activity — a lone entity already resolved through the
            // one-path collapse above. The `!` is sound: length was just checked.
            const only = matches[0]!;
            return ok({ kind: "activity", qn: only.identifier?.toString() ?? "" });
        }
        return err({ type: "ambiguous_search", candidates: toCandidates(matches), total: matches.length });
    }

    // Identifier tier: the ref as the record's own address — the exact token a user copies out of
    // the exported PROV (e.g. `prov:usedEntity: "inflexa:input-…"`). Exact only, and last, so no
    // attribute tier is ever shadowed by an identifier coincidence. Two accepted forms: the full
    // prefixed QName (resolved through the document's namespaces — a string with no known prefix
    // simply misses) and the bare localpart. Relations carry identifiers too (`gen-…`) but are not
    // lineage roots in this grammar, so both probes are constrained to entities and activities.
    const byQName = resolve(graph, { id: ref, type: [ProvEntity, ProvActivity] });
    const byIdentifier =
        byQName.kind === "matched" ? byQName : resolve(graph, { type: [ProvEntity, ProvActivity], where: (r) => r.identifier?.localpart === ref });
    if (byIdentifier.kind === "matched") {
        // Identifiers are unique after unification, so several hits are a malformed edge case
        // (e.g. two prefixes sharing a localpart) — list rather than guess.
        if (byIdentifier.records.length > 1) {
            return err({ type: "ambiguous_search", candidates: toCandidates(byIdentifier.records), total: byIdentifier.records.length });
        }
        const rec = byIdentifier.records[0]!; // length checked: exactly one
        return rec instanceof ProvEntity ? ok({ kind: "files", infos: [toFileInfo(rec)] }) : ok({ kind: "activity", qn: rec.identifier?.toString() ?? "" });
    }

    // The document's own not-found sample mixes every record kind; the contract promises file PATHS,
    // so the sample comes from the pathed-entity sweep instead.
    const knownPaths = [
        ...new Set(
            fileEntities(graph)
                .map((f) => f.path)
                .filter((p): p is string => p !== null),
        ),
    ].slice(0, NOT_FOUND_SAMPLE);
    return err({ type: "not_found", knownPaths });
}

/** The lineage graph over an analysis's document: the last-write-wins unify the flush and export use, folded into the graph build. */
export function lineageGraph(doc: ProvDocument): ProvGraph {
    return provToGraph(doc, PROV_UNIFY_OPTIONS);
}

/**
 * Walk the resolved roots' lineage in ONE multi-root pass. `depth` counts file-level hops; the
 * engine counts edge hops. From a FILE root one file hop (file → activity → file) is two edges, so
 * the bound is `2n`; from an ACTIVITY root the first hop is activity → file (one edge), so the
 * bound is `2n - 1` — either way every frontier truncation lands on a file node, never mid-hop on
 * an activity. Unset stays unset: the engine's {@link MAX_WALK_DEPTH} ceiling then backs
 * "unbounded" and truncates a pathological chain visibly rather than exhausting the walk.
 */
export function computeLineage(graph: ProvGraph, roots: LineageRoots, opts: { forward: boolean; depth?: number }): LineageResult {
    const rootQns = roots.kind === "files" ? roots.infos.map((info) => info.qn) : [roots.qn];
    return lineage(graph, rootQns, {
        direction: opts.forward ? "forward" : "backward",
        // The default "dataflow" profile also traverses derivation and communication; the coarse
        // `wasDerivedFrom(file, analysis)` edge and the command → step → run spine must both stay
        // out of a file's lineage, so the traversable set is exactly generation and usage.
        relations: [ProvGeneration, ProvUsage],
        ...(opts.depth !== undefined ? { depth: roots.kind === "activity" ? 2 * opts.depth - 1 : 2 * opts.depth } : {}),
    });
}

/**
 * The activity's rendering facts: its kind from `prov:type`, its command/tool facts, and its owning
 * step/run. A command has no step/run of its own — its spine is the `wasInformedBy` edge to the step
 * activity, read here as a LABEL off the graph's communication adjacency (the walk never follows
 * communication, but `provToGraph` indexes every relation, so the edge is present for this lookup).
 * A step activity (leaf-file generator) carries the run/step ids directly.
 */
function activityMeta(graph: ProvGraph, uri: string): Omit<LineageActivity, "files"> {
    const element = graph.getNode(uri)?.element;
    const qn = element?.identifier?.toString() ?? uri;
    const typeForms = element === undefined ? [] : element.getAttribute("prov:type").flatMap((v) => [...normalizeAttrValue(v)]);
    const kind = typeForms.includes("inflexa:Command")
        ? "command"
        : typeForms.includes("inflexa:FileToolWrite")
          ? "file_tool"
          : typeForms.includes("inflexa:Step")
            ? "step"
            : "activity";
    const command = element === undefined ? undefined : firstAttr(element, "inflexa:command");
    const exitCodeRaw = element === undefined ? undefined : firstAttr(element, "inflexa:exitCode");
    const exitCode = exitCodeRaw !== undefined && Number.isFinite(Number(exitCodeRaw)) ? Number(exitCodeRaw) : undefined;
    const tool = element === undefined ? undefined : firstAttr(element, "inflexa:tool");
    let runId = element === undefined ? undefined : firstAttr(element, "inflexa:runId");
    let stepId = element === undefined ? undefined : firstAttr(element, "inflexa:stepId");
    if (runId === undefined && stepId === undefined) {
        const stepUri = graph.outEdges(uri).find((e) => e.relation instanceof ProvCommunication)?.to;
        const stepElement = stepUri === undefined ? undefined : graph.getNode(stepUri)?.element;
        runId = stepElement === undefined ? undefined : firstAttr(stepElement, "inflexa:runId");
        stepId = stepElement === undefined ? undefined : firstAttr(stepElement, "inflexa:stepId");
    }
    return {
        qn,
        kind,
        ...(command !== undefined ? { command } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(tool !== undefined ? { tool } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(stepId !== undefined ? { stepId } : {}),
    };
}

/** The file-identity facts for the node at `uri`, read off its element (a missing node still renders — with null facts). */
function fileInfoOf(graph: ProvGraph, uri: string): LineageFileInfo {
    const element = graph.getNode(uri)?.element;
    const read = (name: AttrKey): string | null => (element === undefined ? null : (firstAttr(element, name) ?? null));
    return { qn: element?.identifier?.toString() ?? uri, path: read("inflexa:path"), hash: read("inflexa:hash"), source: read("inflexa:source") };
}

/** Both orientations of the walk's generation/usage edges, keyed by node URI — the adjacency the tree renders per root. */
type WalkEdges = {
    /** entity URI → its generating activity URIs. */
    generatedBy: Map<string, string[]>;
    /** activity URI → the entity URIs it generated. */
    generates: Map<string, string[]>;
    /** activity URI → the entity URIs it used. */
    uses: Map<string, string[]>;
    /** entity URI → the activity URIs that used it. */
    usedBy: Map<string, string[]>;
};

/** Index the flat result's traversed edges into both orientations. Generation points entity → activity, usage activity → entity. */
function indexWalkEdges(result: LineageResult): WalkEdges {
    const edges: WalkEdges = { generatedBy: new Map(), generates: new Map(), uses: new Map(), usedBy: new Map() };
    const push = (map: Map<string, string[]>, key: string, value: string): void => {
        const bucket = map.get(key);
        if (bucket) bucket.push(value);
        else map.set(key, [value]);
    };
    for (const edge of result.edges) {
        if (edge.relation instanceof ProvGeneration) {
            push(edges.generatedBy, edge.from, edge.to);
            push(edges.generates, edge.to, edge.from);
        } else if (edge.relation instanceof ProvUsage) {
            push(edges.uses, edge.from, edge.to);
            push(edges.usedBy, edge.to, edge.from);
        }
    }
    return edges;
}

/** One rendered root: a file entity's walk tree, or an activity root carrying its walked-side file subtrees. */
type RootTree = { kind: "file"; file: LineageFile } | { kind: "activity"; activity: LineageActivity };

/**
 * Rebuild one root's walk tree from the flat result, with the per-root rendering semantics the tree
 * relies on: a private visited set per root, a re-encounter marked a `revisit` (checked BEFORE the
 * depth cut, so a cycle's back-edge always reads as a reference, never a truncation), and the
 * file-hop `--depth` bound enforced here. A node the bound cuts is a `depth` truncation only when
 * the walk recorded something beyond it — an onward edge in the result, or an engine frontier entry
 * (the "unbounded" ceiling); otherwise its emptiness is genuine and it renders as a terminal.
 *
 * An ACTIVITY root's tree starts one engine edge in — its direct files sit at the first file hop,
 * so they take the remaining budget `budget - 1`, matching the engine's `2n - 1` bound for
 * activity-rooted walks. The root's kind is read off the graph node's element class: the walk's
 * seed set is kind-homogeneous, but per-root detection keeps the renderer honest either way.
 *
 * The single multi-root walk is exact for this: BFS reaches every node at its MINIMUM distance over
 * all roots (≤ its distance from any one root), so the merged result already holds every edge any
 * per-root render up to the same bound could need, and this render just re-imposes the per-root
 * bound and visited set on top.
 */
function buildRootTree(graph: ProvGraph, edges: WalkEdges, frontier: Set<string>, rootUri: string, forward: boolean, budget: number): RootTree {
    const visited = new Set<string>();
    const onwardActivities = (uri: string): string[] => (forward ? edges.usedBy.get(uri) : edges.generatedBy.get(uri)) ?? [];
    const activityFiles = (uri: string): string[] => (forward ? edges.generates.get(uri) : edges.uses.get(uri)) ?? [];
    const step = (uri: string, remaining: number): LineageFile => {
        const info = fileInfoOf(graph, uri);
        if (visited.has(uri)) return { ...info, marker: "revisit", activities: [] };
        const activityUris = onwardActivities(uri);
        if (remaining <= 0) {
            const truncated = activityUris.length > 0 || frontier.has(uri);
            return { ...info, ...(truncated ? { marker: "depth" as const } : {}), activities: [] };
        }
        visited.add(uri);
        const activities = activityUris.map((auri): LineageActivity => ({
            ...activityMeta(graph, auri),
            files: activityFiles(auri).map((furi) => step(furi, remaining - 1)),
        }));
        // Reached within budget but the engine's ceiling stopped here: no onward edge was recorded,
        // so the branch is incomplete, not a terminal — mark it truncated rather than a clean leaf.
        if (activities.length === 0 && frontier.has(uri)) return { ...info, marker: "depth", activities: [] };
        return { ...info, activities };
    };
    if (graph.getNode(rootUri)?.element instanceof ProvActivity) {
        return {
            kind: "activity",
            activity: { ...activityMeta(graph, rootUri), files: activityFiles(rootUri).map((furi) => step(furi, budget - 1)) },
        };
    }
    return { kind: "file", file: step(rootUri, budget) };
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
 * The fact half of an activity's rendering: what ran, and where (step, run). Shared by the tree
 * line and the dot label so the two formats can never drift on how an activity is described. A
 * STEP activity is marked `(step-grain)`: its edges are recorded against the step, not the
 * individual file — a step's step-level reads and its leaf-file generations connect through step
 * membership, an honest upper bound, not the per-file fact a command edge states. The marking
 * keeps the two grains visually distinct so a coarse connection is never mistaken for a fine one.
 */
function activityFacts(activity: Omit<LineageActivity, "files">): string {
    const what =
        activity.kind === "command"
            ? `${activity.command ?? "command"}${activity.exitCode !== undefined ? ` (exit ${activity.exitCode})` : ""}`
            : activity.kind === "file_tool"
              ? `${activity.tool ?? "file tool"} (file tool)`
              : activity.kind === "step"
                ? "step (step-grain)"
                : activity.qn;
    const where = activity.runId !== undefined || activity.stepId !== undefined ? ` — step ${activity.stepId ?? "?"}, run ${activity.runId ?? "?"}` : "";
    return `${what}${where}`;
}

/** One human line for an activity node: the traversal verb plus the activity's facts. */
function activityLine(activity: LineageActivity, forward: boolean): string {
    return `${forward ? "used by" : "generated by"}: ${activityFacts(activity)}`;
}

/**
 * Render walk trees for humans: one lineage per resolved root, each activity beneath its file and
 * each input/output file indented beneath its activity. An ACTIVITY root leads with its own fact
 * line — no "generated by:"/"used by:" verb, since the root is not reached via an edge — with the
 * files it used (backward) or generated (forward) beneath. An expanded file with no activities is
 * labeled a terminal ("no recorded …") rather than left bare — absence of recorded inputs must
 * never read as certainty that none existed (tool reads are a known recording gap).
 */
export function formatTree(graph: ProvGraph, result: LineageResult, opts: { forward: boolean; depth?: number }): string {
    const forward = opts.forward;
    const edges = indexWalkEdges(result);
    const frontier = new Set(result.frontier.map((f) => f.uri));
    const budget = opts.depth ?? MAX_WALK_DEPTH;
    const roots = result.roots.map((uri) => buildRootTree(graph, edges, frontier, uri, forward, budget));

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
    const renderActivityRoot = (activity: LineageActivity): void => {
        lines.push(activityFacts(activity));
        if (activity.files.length === 0) {
            // A searchable activity is a command or file tool by construction (steps carry neither
            // a command nor a tool), so the step-grain absence wordings can never apply here.
            lines.push(`└─ ${forward ? "no recorded readers of this output" : "no recorded inputs"}`);
            return;
        }
        for (const [j, child] of activity.files.entries()) {
            renderFile(child, "", j === activity.files.length - 1, false);
        }
    };
    for (const [i, root] of roots.entries()) {
        if (i > 0) lines.push("");
        if (root.kind === "activity") renderActivityRoot(root.activity);
        else renderFile(root.file, "", true, true);
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

/** The JSON node for a file entity, carrying `truncated: true` exactly when the walk recorded no expansion of it. */
function fileJsonNode(graph: ProvGraph, uri: string, truncated: boolean): LineageJsonNode {
    const info = fileInfoOf(graph, uri);
    return { kind: "file", path: info.path, hash: info.hash, source: info.source, ...(truncated ? { truncated: true as const } : {}) };
}

/** The JSON node for an activity — its rendering facts minus the QName key and the tree-only `files`. */
function activityJsonNode(graph: ProvGraph, uri: string): LineageJsonNode {
    const { qn: _qn, ...facts } = activityMeta(graph, uri);
    // `facts` is the kind plus only the fields that kind carries (a command never has `tool`, a
    // file tool never has `command`), because `activityMeta` populates them off the element's own
    // attributes — so the shape already satisfies the kind-discriminated union the assertion names.
    return facts as LineageJsonNode;
}

/**
 * Flatten the walk into `{ roots, nodes, edges }`. Nodes are keyed by prefixed QName, so a
 * re-encounter dedups naturally; a file node carries `truncated: true` only when the walk recorded
 * NO expansion of it anywhere — the engine's frontier semantics (BFS min-distance) give this
 * directly. Edges are emitted in PROV semantics regardless of walk direction: `wasGeneratedBy` is
 * always entity → activity and `used` always activity → entity, so a consumer re-derives either
 * direction from one representation.
 */
export function formatJson(graph: ProvGraph, result: LineageResult): LineageJson {
    const flat = toFlatGraph(result);
    const truncated = new Set<string>();
    for (const node of flat.nodes) if (node.truncated !== undefined) truncated.add(node.uri);

    // Node keys are the prefixed QName, not the flat graph's full URI — the published `--format json`
    // contract keys `nodes` by `inflexa:file-…`, so translate each node's URI at the boundary.
    const uriToQn = new Map<string, string>();
    const nodes: Record<string, LineageJsonNode> = {};
    for (const node of result.nodes) {
        const qn = node.element.identifier?.toString();
        if (qn === undefined) continue;
        uriToQn.set(node.uri, qn);
        nodes[qn] = node.element instanceof ProvEntity ? fileJsonNode(graph, node.uri, truncated.has(node.uri)) : activityJsonNode(graph, node.uri);
    }

    const edgeKeys = new Set<string>();
    const edges: LineageJson["edges"] = [];
    for (const edge of result.edges) {
        const kind = edge.relation instanceof ProvGeneration ? "wasGeneratedBy" : edge.relation instanceof ProvUsage ? "used" : undefined;
        if (kind === undefined) continue;
        const from = uriToQn.get(edge.from);
        const to = uriToQn.get(edge.to);
        if (from === undefined || to === undefined) continue;
        const key = `${kind}|${from}|${to}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ from, to, kind });
    }

    const roots = result.roots.map((uri) => uriToQn.get(uri)).filter((qn): qn is string => qn !== undefined);
    return { roots, nodes, edges };
}

/**
 * A Graphviz double-quoted string: backslashes escaped before quotes, so an escaped quote's own
 * backslash survives the first pass. Node ids go through this too — a prefixed QName carries `:`,
 * which a bare dot ID disallows, so every id must be quoted.
 */
function dotQuoted(s: string): string {
    return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** One dot node statement: files are boxes (dashed + suffixed when truncated), activities ellipses labeled with the tree's facts. */
function dotNodeStatement(qn: string, node: LineageJsonNode): string {
    if (node.kind === "file") {
        const truncated = node.truncated === true;
        const label = `${node.path ?? qn}  (hash ${shortHash(node.hash)})${truncated ? "  [truncated]" : ""}`;
        return `    ${dotQuoted(qn)} [shape=box${truncated ? ", style=dashed" : ""}, label=${dotQuoted(label)}];`;
    }
    return `    ${dotQuoted(qn)} [shape=ellipse, label=${dotQuoted(activityFacts({ qn, ...node }))}];`;
}

/**
 * Render the walk as a Graphviz `digraph` — a pure text formatter over the same flat projection
 * `formatJson` exposes, meant to be piped into graphviz (`| dot -Tsvg`); nothing here invokes it.
 * Node ids are the prefixed QNames; file nodes are boxes labeled with path + short hash, activity
 * nodes ellipses labeled with the same facts the tree shows (command + exit code, tool, or the
 * step-grain marking, plus step/run). A truncated file renders dashed with a `[truncated]` label
 * suffix, so a cut branch never looks like a clean leaf. Edges are exactly the JSON edge set — in
 * asserted PROV orientation regardless of walk direction, labeled by kind — so a graph rendered
 * from either walk direction carries identical edges.
 */
export function formatDot(graph: ProvGraph, result: LineageResult): string {
    const flat = formatJson(graph, result);
    const lines: string[] = ["digraph lineage {"];
    for (const [qn, node] of Object.entries(flat.nodes)) lines.push(dotNodeStatement(qn, node));
    for (const edge of flat.edges) lines.push(`    ${dotQuoted(edge.from)} -> ${dotQuoted(edge.to)} [label=${dotQuoted(edge.kind)}];`);
    lines.push("}");
    return lines.join("\n");
}

/** A Mermaid quoted label: embedded double quotes become Mermaid's entity escape, so any command line survives inside the quotes. */
function mermaidLabel(label: string): string {
    return `"${label.replaceAll('"', "#quot;")}"`;
}

/**
 * Render the walk as Mermaid `flowchart` source — a pure text emitter over the same flat
 * projection `formatJson` exposes; the user pipes it into any Mermaid consumer (nothing here
 * renders). Node ids are a grammar-safe transform of the prefixed QNames (Mermaid ids reject `:`):
 * every character outside `[A-Za-z0-9_]` becomes `_`, with a numeric suffix on the rare collision
 * so distinct records can never share an id. Entities render rounded (`id(["…"])`), activities as
 * rectangles (`id["…"]`) — the PROV visual convention — labeled with the same facts the tree
 * shows, always in the quoted form with embedded `"` escaped, so command lines carrying quotes or
 * punctuation still parse. Edges are exactly the JSON edge set in asserted PROV orientation, the
 * relation visible in both the arrow style and its label: solid `-->|wasGeneratedBy|`, dotted
 * `-.->|used|`. Unlike the tree, a shared intermediate appears ONCE with all its edges — this is
 * the format that shows the true DAG shape.
 */
export function formatMermaid(graph: ProvGraph, result: LineageResult): string {
    const flat = formatJson(graph, result);
    // QName → grammar-safe id. The sanitize is injective over realistic QNames; the suffix loop
    // makes uniqueness airtight rather than assumed.
    const ids = new Map<string, string>();
    const taken = new Set<string>();
    const idOf = (qn: string): string => {
        const existing = ids.get(qn);
        if (existing !== undefined) return existing;
        const base = qn.replaceAll(/[^A-Za-z0-9_]/g, "_");
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
        ids.set(qn, id);
        taken.add(id);
        return id;
    };
    const lines: string[] = ["flowchart LR"];
    for (const [qn, node] of Object.entries(flat.nodes)) {
        if (node.kind === "file") {
            const truncated = node.truncated === true;
            const label = `${node.path ?? qn}  (hash ${shortHash(node.hash)})${truncated ? "  [truncated]" : ""}`;
            lines.push(`    ${idOf(qn)}([${mermaidLabel(label)}])`);
        } else {
            lines.push(`    ${idOf(qn)}[${mermaidLabel(activityFacts({ qn, ...node }))}]`);
        }
    }
    for (const edge of flat.edges) {
        lines.push(
            edge.kind === "wasGeneratedBy"
                ? `    ${idOf(edge.from)} -->|wasGeneratedBy| ${idOf(edge.to)}`
                : `    ${idOf(edge.from)} -.->|used| ${idOf(edge.to)}`,
        );
    }
    return lines.join("\n");
}

/** The validated `prov lineage` options, parsed at the CLI boundary. */
type LineageOptions = { forward: boolean; depth?: number; format: "tree" | "json" | "dot" | "mermaid" };

/** Validate the raw commander options; any invalid flag fails with the accepted values. */
function parseOptions(opts: { forward?: boolean; depth?: string; format?: string }): LineageOptions {
    const format = (opts.format ?? "tree").toLowerCase();
    if (format !== "tree" && format !== "json" && format !== "dot" && format !== "mermaid")
        fail(`Unknown format "${opts.format}". Use "tree", "json", "dot", or "mermaid".`);
    let depth: number | undefined;
    if (opts.depth !== undefined) {
        depth = Number(opts.depth);
        if (!Number.isInteger(depth) || depth < 1) fail(`--depth must be a positive integer, got "${opts.depth}".`);
    }
    return { forward: opts.forward ?? false, depth, format };
}

/**
 * `inflexa prov lineage <analysis> <ref> [--forward] [--depth n] [--format tree|json|dot|mermaid]`
 * — resolve the ref (a file path, content hash, hash prefix, search string, or record QName) in
 * the analysis's stored provenance document and print its lineage. Reads the same stored bytes
 * `export` serializes; an analysis with no recorded provenance fails with an actionable message
 * rather than an empty walk.
 */
export function runProvLineage(analysisRef: string, ref: string, rawOpts: { forward?: boolean; depth?: string; format?: string }): void {
    const opts = parseOptions(rawOpts);

    const analysis = requireAnalysisForProv(analysisRef);

    const stored = getAnalysisProvenance(analysis.id).match((s) => s, dieOn("Failed to read provenance"));
    if (stored === null) fail(`No provenance recorded for "${analysis.name}" yet — run an analysis first.`);

    const doc = loadDocument(analysis, stored).match((d) => d, dieOn("Stored provenance is corrupt"));
    const graph = lineageGraph(doc);

    const roots = resolveLineageRef(graph, ref).match(
        (r) => r,
        (e) => {
            if (e.type === "ambiguous_hash") {
                const list = e.candidates.map((c) => `  ${c.hash ?? "?"}  ${c.path ?? "?"}`).join("\n");
                fail(`Hash prefix "${ref}" is ambiguous — candidates:\n${list}`);
            }
            if (e.type === "ambiguous_search") {
                const list = e.candidates
                    .map((c) => (c.kind === "file" ? `  file      ${c.path ?? "?"}  (hash ${shortHash(c.hash)})` : `  activity  ${c.line}`))
                    .join("\n");
                const more = e.total - e.candidates.length;
                fail(`"${ref}" matches ${e.total} records — candidates:\n${list}${more > 0 ? `\n  + ${more} more` : ""}`);
            }
            const hint = e.knownPaths.length > 0 ? `\nKnown files include:\n${e.knownPaths.map((p) => `  ${p}`).join("\n")}` : "";
            fail(`No file matching "${ref}" in the provenance of "${analysis.name}".${hint}`);
        },
    );

    const result = computeLineage(graph, roots, { forward: opts.forward, depth: opts.depth });
    if (opts.format === "json") console.log(JSON.stringify(formatJson(graph, result), null, 2));
    else if (opts.format === "dot") console.log(formatDot(graph, result));
    else if (opts.format === "mermaid") console.log(formatMermaid(graph, result));
    else console.log(formatTree(graph, result, { forward: opts.forward, depth: opts.depth }));
}
