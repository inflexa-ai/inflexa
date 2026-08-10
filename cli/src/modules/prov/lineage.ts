import { ok, err, type Result } from "neverthrow";
import {
    computeLineage as kernelComputeLineage,
    deriveLineageModel,
    type LineageActivityNode,
    type LineageModel,
    type LineageNode,
    type LineageWalk as KernelWalk,
} from "@inflexa-ai/prov-kernel";

import { dieOn, fail } from "../../lib/cli.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { requireAnalysisForProv } from "./prov.ts";

// The read-side answer to "where did this file come from?" (and, with --forward, "what came from
// this file?"), over the same stored bytes `export` serializes. The kernel owns the interpretation
// and the walk; this file owns CLI presentation: ref resolution, scoped absence claims, and the
// tree/JSON/dot/mermaid rendering.
//
// The walk follows ONLY generation and usage edges. The document's coarse
// `wasDerivedFrom(file, analysis)` edge and its `wasInformedBy` command → step → run spine would
// pollute a file's lineage, so neither is walked; the spine is instead folded into the model as
// command labels.

/** Minimum hash-prefix length a lineage ref may resolve by — shorter prefixes are too collision-prone to guess on. */
const MIN_HASH_PREFIX = 6;

/**
 * The safety ceiling backing an "unbounded" walk, in file-level hops. The kernel walk has no
 * ceiling of its own, so a pathological chain truncates visibly here rather than exhausting the
 * render stack.
 */
const MAX_WALK_DEPTH = 500;

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
    /**
     * A script path the command referenced that resolved to no recorded file entity — a lost input
     * attribution the recorder saw and could not key. Present only on a `command` activity whose
     * `scriptPath` matched neither an output nor an input; carried as activity metadata, never a graph
     * node (the unattributable path has no `(path, hash)` key), so the renderer can word the gap.
     */
    unresolvedScript?: string;
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

/** The kernel walk (reached sub-model + its truncation set) plus the root QNames the tree renders per. */
export type LineageWalk = KernelWalk & { roots: string[] };

/** The QName's localpart, for example `file-18bvqsvo19q9p` from `inflexa:file-…`. */
function localpart(qn: string): string {
    const colon = qn.indexOf(":");
    return colon === -1 ? qn : qn.slice(colon + 1);
}

type EntityNode = Extract<LineageNode, { kind: "analysis" | "input" | "file" }>;

/** The model's entity node kinds — the walkable/addressable records that are not activities or agents. */
function isEntity(node: LineageNode): node is EntityNode {
    return node.kind === "analysis" || node.kind === "input" || node.kind === "file";
}

/** An entity node as a {@link LineageFileInfo} — its QName plus the identity facts its kind carries. */
function toFileInfo(node: LineageNode): LineageFileInfo {
    const path = (node.kind === "file" || node.kind === "input") && node.path !== undefined ? node.path : null;
    const hash = node.kind === "file" && node.hash !== undefined ? node.hash : null;
    const source = node.kind === "file" && node.source !== undefined ? node.source : null;
    return { qn: node.qn, path, hash, source };
}

/**
 * The activity's rendering facts off its model node. The kernel already did the format work: kind
 * classification from `prov:type`, and the run/step ids a command inherits from its owning step
 * (folded in off the `informed` edge at model derivation). The kernel's `run` and `action` kinds
 * both render as the generic `activity` here — neither carries command facts.
 */
function activityMeta(node: LineageActivityNode | undefined, qn: string): Omit<LineageActivity, "files"> {
    if (node === undefined) return { qn, kind: "activity" };
    const kind = node.activity === "command" || node.activity === "file_tool" || node.activity === "step" ? node.activity : "activity";
    return {
        qn: node.qn,
        kind,
        ...(node.command !== undefined ? { command: node.command } : {}),
        ...(node.exitCode !== undefined ? { exitCode: node.exitCode } : {}),
        ...(node.tool !== undefined ? { tool: node.tool } : {}),
        ...(node.unresolvedScript !== undefined ? { unresolvedScript: node.unresolvedScript } : {}),
        ...(node.runId !== undefined ? { runId: node.runId } : {}),
        ...(node.stepId !== undefined ? { stepId: node.stepId } : {}),
    };
}

/** Every pathed entity in the model — file or input, whatever its QName scheme — for the not-found sample. */
function pathedInfos(model: LineageModel): LineageFileInfo[] {
    return model.nodes.filter((n) => (n.kind === "file" || n.kind === "input") && n.path !== undefined).map(toFileInfo);
}

/**
 * Resolve a lineage ref through five tiers: exact `path` (ALL entities carrying it — the same
 * path re-written across runs is several genuinely distinct entities, surfaced, not hidden),
 * exact `hash`, an unambiguous hash prefix of ≥ {@link MIN_HASH_PREFIX} chars, a case-sensitive
 * substring search over recorded paths, command lines, and tool names, and — when even the search
 * finds nothing — an exact-identifier match against entity and activity QNames, accepting the
 * full prefixed form (`inflexa:input-…`) or the bare localpart (`input-…`): the token a user
 * copies straight out of the exported PROV. Hashes are deliberately never substring-searched —
 * hash addressing stays exact-or-prefix, git-style; a substring hit inside a digest is noise,
 * never intent — and identifier matching is exact only, placed last so it can never shadow an
 * attribute tier. A single search match resolves (an activity match roots the walk there);
 * matches that are all entities of ONE path collapse to that path's entity set — the same
 * multiplicity the exact-path tier surfaces; any other mix fails with kind-tagged candidates
 * rather than walking a surprise forest. No match at any tier fails with a sample of the paths
 * the document does know. Directory-style refs carry no special semantics: they land in the
 * candidate or not-found failure like any string.
 */
export function resolveLineageRef(model: LineageModel, ref: string): Result<LineageRoots, LineageRefError> {
    const byPath = model.nodes.filter((n) => (n.kind === "file" || n.kind === "input") && n.path === ref);
    if (byPath.length > 0) return ok({ kind: "files", infos: byPath.map(toFileInfo) });

    const byHash = model.nodes.filter((n) => n.kind === "file" && n.hash === ref);
    if (byHash.length > 0) return ok({ kind: "files", infos: byHash.map(toFileInfo) });

    if (ref.length >= MIN_HASH_PREFIX) {
        const byPrefix = model.nodes.filter((n) => n.kind === "file" && n.hash !== undefined && n.hash.startsWith(ref));
        if (byPrefix.length === 1) return ok({ kind: "files", infos: [toFileInfo(byPrefix[0]!)] });
        if (byPrefix.length > 1) {
            return err({
                type: "ambiguous_hash",
                candidates: byPrefix.map(toFileInfo).map((info) => ({ path: info.path, hash: info.hash })),
            });
        }
    }

    // Shared by every ambiguous outcome below, so the substring and identifier tiers can never
    // drift on how a candidate is described.
    const toCandidates = (nodes: readonly LineageNode[]): LineageSearchCandidate[] =>
        nodes.slice(0, SEARCH_CANDIDATE_CAP).map((node): LineageSearchCandidate => {
            if (isEntity(node)) {
                const info = toFileInfo(node);
                return { kind: "file", path: info.path, hash: info.hash };
            }
            return { kind: "activity", line: activityFacts(activityMeta(node.kind === "activity" ? node : undefined, node.qn)) };
        });

    // Search tier: the ref as a substring over the three searchable targets, in a fixed probe
    // order so candidate listings are deterministic. Entities and activities are disjoint node
    // kinds, and no activity carries both a command and a tool, but the QName dedup guards the
    // accounting anyway — a double-counted match would inflate `total`.
    const matches: LineageNode[] = [];
    const seen = new Set<string>();
    const collect = (nodes: readonly LineageNode[]): void => {
        for (const node of nodes) {
            if (seen.has(node.qn)) continue;
            seen.add(node.qn);
            matches.push(node);
        }
    };
    collect(model.nodes.filter((n) => (n.kind === "file" || n.kind === "input") && n.path !== undefined && n.path.includes(ref)));
    collect(model.nodes.filter((n) => n.kind === "activity" && n.command !== undefined && n.command.includes(ref)));
    collect(model.nodes.filter((n) => n.kind === "activity" && n.tool !== undefined && n.tool.includes(ref)));

    if (matches.length > 0) {
        const entities = matches.filter(isEntity);
        if (entities.length === matches.length) {
            // Every entity carrying a path P also contains any substring of P, so an all-one-path
            // match set already IS that path's full entity set — no second query needed.
            const paths = new Set(entities.map((node) => toFileInfo(node).path));
            if (paths.size === 1) return ok({ kind: "files", infos: entities.map(toFileInfo) });
        }
        if (matches.length === 1) {
            // A lone match here is always an activity — a lone entity already resolved through the
            // one-path collapse above. The `!` is sound: length was just checked.
            return ok({ kind: "activity", qn: matches[0]!.qn });
        }
        return err({ type: "ambiguous_search", candidates: toCandidates(matches), total: matches.length });
    }

    // Identifier tier: the ref as the record's own address — the exact token a user copies out of
    // the exported PROV (e.g. `prov:usedEntity: "inflexa:input-…"`). Exact only, and last, so no
    // attribute tier is ever shadowed by an identifier coincidence. Two accepted forms: the full
    // prefixed QName and the bare localpart. Relations and agents carry identifiers too but are
    // not lineage roots in this grammar, so both probes are constrained to entity and activity
    // nodes.
    const addressable = model.nodes.filter((n) => n.kind !== "agent");
    const byQName = addressable.filter((n) => n.qn === ref);
    const byIdentifier = byQName.length > 0 ? byQName : addressable.filter((n) => localpart(n.qn) === ref);
    if (byIdentifier.length > 0) {
        // Identifiers are unique after unification, so several hits are a malformed edge case
        // (e.g. two prefixes sharing a localpart) — list rather than guess.
        if (byIdentifier.length > 1) {
            return err({ type: "ambiguous_search", candidates: toCandidates(byIdentifier), total: byIdentifier.length });
        }
        const node = byIdentifier[0]!; // length checked: exactly one
        return isEntity(node) ? ok({ kind: "files", infos: [toFileInfo(node)] }) : ok({ kind: "activity", qn: node.qn });
    }

    // The contract promises file PATHS, so the orientation sample comes from the pathed-entity
    // sweep — never a mixed dump of every record kind.
    const knownPaths = [
        ...new Set(
            pathedInfos(model)
                .map((f) => f.path)
                .filter((p): p is string => p !== null),
        ),
    ].slice(0, NOT_FOUND_SAMPLE);
    return err({ type: "not_found", knownPaths });
}

/**
 * Walk the resolved roots' lineage in ONE multi-root kernel pass. `depth` is the kernel's own
 * file-hop semantics, so a truncation always lands on a file node; unset falls back to the
 * {@link MAX_WALK_DEPTH} ceiling.
 */
export function computeLineage(model: LineageModel, roots: LineageRoots, opts: { forward: boolean; depth?: number }): LineageWalk {
    const rootQns = roots.kind === "files" ? roots.infos.map((info) => info.qn) : [roots.qn];
    const walk = kernelComputeLineage(model, rootQns, {
        direction: opts.forward ? "forward" : "backward",
        depth: opts.depth ?? MAX_WALK_DEPTH,
    });
    return { ...walk, roots: rootQns };
}

/** Both orientations of the walk's generation/usage edges, keyed by node QName — the adjacency the tree renders per root. */
type WalkEdges = {
    /** entity QName → its generating activity QNames. */
    generatedBy: Map<string, string[]>;
    /** activity QName → the entity QNames it generated. */
    generates: Map<string, string[]>;
    /** activity QName → the entity QNames it used. */
    uses: Map<string, string[]>;
    /** entity QName → the activity QNames that used it. */
    usedBy: Map<string, string[]>;
};

/** Index the walk's traversed edges into both orientations. Generation points entity → activity, usage activity → entity. */
function indexWalkEdges(walk: LineageModel): WalkEdges {
    const edges: WalkEdges = { generatedBy: new Map(), generates: new Map(), uses: new Map(), usedBy: new Map() };
    const push = (map: Map<string, string[]>, key: string, value: string): void => {
        const bucket = map.get(key);
        if (bucket) bucket.push(value);
        else map.set(key, [value]);
    };
    for (const edge of walk.edges) {
        if (edge.kind === "generated") {
            push(edges.generatedBy, edge.from, edge.to);
            push(edges.generates, edge.to, edge.from);
        } else if (edge.kind === "used") {
            push(edges.uses, edge.from, edge.to);
            push(edges.usedBy, edge.to, edge.from);
        }
    }
    return edges;
}

/** One rendered root: a file entity's walk tree, or an activity root carrying its walked-side file subtrees. */
type RootTree = { kind: "file"; file: LineageFile } | { kind: "activity"; activity: LineageActivity };

/** The activity facts for the node at `qn` (a non-activity or missing node still renders — as the bare generic kind). */
function activityMetaOf(nodes: Map<string, LineageNode>, qn: string): Omit<LineageActivity, "files"> {
    const node = nodes.get(qn);
    return activityMeta(node?.kind === "activity" ? node : undefined, qn);
}

/** The file-identity facts for the node at `qn` (a missing node still renders — with null facts). */
function fileInfoOf(nodes: Map<string, LineageNode>, qn: string): LineageFileInfo {
    const node = nodes.get(qn);
    return node === undefined ? { qn, path: null, hash: null, source: null } : toFileInfo(node);
}

/**
 * Rebuild one root's tree from the flat walk, re-imposing the per-root rendering semantics: a
 * private visited set, a re-encounter marked a `revisit` (checked BEFORE the depth cut, so a
 * cycle's back-edge always reads as a reference, never a truncation), and the file-hop bound. A cut
 * node is a `depth` truncation only when something lies beyond it; otherwise it is a genuine
 * terminal. An ACTIVITY root starts one walk edge in, so its direct files take `budget - 1`.
 *
 * The single multi-root walk is exact for this: BFS reaches every node at its MINIMUM distance over
 * all roots, so the merged walk already holds every edge any per-root render up to the same bound
 * could need.
 */
function buildRootTree(
    nodes: Map<string, LineageNode>,
    edges: WalkEdges,
    truncated: ReadonlySet<string>,
    rootQn: string,
    forward: boolean,
    budget: number,
): RootTree {
    const visited = new Set<string>();
    const onwardActivities = (qn: string): string[] => (forward ? edges.usedBy.get(qn) : edges.generatedBy.get(qn)) ?? [];
    const activityFiles = (qn: string): string[] => (forward ? edges.generates.get(qn) : edges.uses.get(qn)) ?? [];
    const step = (qn: string, remaining: number): LineageFile => {
        const info = fileInfoOf(nodes, qn);
        if (visited.has(qn)) return { ...info, marker: "revisit", activities: [] };
        const activityQns = onwardActivities(qn);
        if (remaining <= 0) {
            const cut = activityQns.length > 0 || truncated.has(qn);
            return { ...info, ...(cut ? { marker: "depth" as const } : {}), activities: [] };
        }
        visited.add(qn);
        const activities = activityQns.map((aqn): LineageActivity => ({
            ...activityMetaOf(nodes, aqn),
            files: activityFiles(aqn).map((fqn) => step(fqn, remaining - 1)),
        }));
        return { ...info, activities };
    };
    if (nodes.get(rootQn)?.kind === "activity") {
        return {
            kind: "activity",
            activity: { ...activityMetaOf(nodes, rootQn), files: activityFiles(rootQn).map((fqn) => step(fqn, budget - 1)) },
        };
    }
    return { kind: "file", file: step(rootQn, budget) };
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
 *
 * An activity's empty branch is worded by what the record CLAIMS, not one hedge for all: a file-tool
 * write reads nothing by design (a positive claim), a command hedges, a step scopes to step grain.
 * A command that referenced a script the recorder could not attribute (`inflexa:unresolvedScript`)
 * prints that script as a distinct child line — never a file — and the walk ends with one note
 * counting such gaps, so a reviewer cannot mistake the understated tree for the whole story.
 */
export function formatTree(walk: LineageWalk, opts: { forward: boolean; depth?: number }): string {
    const forward = opts.forward;
    const nodes = new Map(walk.nodes.map((n) => [n.qn, n]));
    const edges = indexWalkEdges(walk);
    const truncated = new Set(walk.truncated);
    const budget = opts.depth ?? MAX_WALK_DEPTH;
    const roots = walk.roots.map((qn) => buildRootTree(nodes, edges, truncated, qn, forward, budget));

    const lines: string[] = [];
    // Distinct activities the render surfaced an attribution gap under, deduped by QName — a diamond
    // that renders one gap activity twice is still one lost attribution, so the footer counts it once.
    const gapActivities = new Set<string>();

    // The wording for an activity's empty branch, scoped to what the record CLAIMS: a file-tool write
    // attests agent-authored bytes (a POSITIVE by-design absence, not a hedge — no unobserved reads
    // exist to hedge against); a command hedges (tool reads ARE a known recording gap); a step scopes
    // its claim to step grain (commands inside the step carry their own reads/outputs). Forward, the
    // side is outputs, so the only honest wording is "no recorded readers" regardless of kind.
    const emptyLabel = (activity: LineageActivity): string => {
        if (activity.kind === "step") return forward ? "no step-grain outputs (command outputs are attributed to their commands)" : "no step-grain inputs";
        if (forward) return "no recorded readers of this output";
        if (activity.kind === "file_tool") return "agent-authored — no file inputs by design";
        return "no recorded inputs";
    };

    // The unresolved script to surface beneath an activity, or undefined. Backward only: it is a lost
    // INPUT attribution, meaningless on the output side. A `used` edge to a file at that path is the
    // stronger claim (a mixed old/new document could re-emit both the attribute and the resolved edge),
    // so the gap is suppressed when that resolved read is present among the activity's used files.
    const gapOf = (activity: LineageActivity): string | undefined => {
        if (forward || activity.unresolvedScript === undefined) return undefined;
        if (activity.files.some((f) => f.path === activity.unresolvedScript)) return undefined;
        return activity.unresolvedScript;
    };

    const renderActivityChildren = (activity: LineageActivity, prefix: string): void => {
        const gap = gapOf(activity);
        if (activity.files.length === 0 && gap === undefined) {
            lines.push(`${prefix}└─ ${emptyLabel(activity)}`);
            return;
        }
        for (const [j, child] of activity.files.entries()) {
            // The gap line, when present, is the branch's tail — so an unattributable script never
            // sits above a real input file, and a real file is never mistaken for the whole story.
            renderFile(child, prefix, gap === undefined && j === activity.files.length - 1, false);
        }
        if (gap !== undefined) {
            gapActivities.add(activity.qn);
            lines.push(`${prefix}└─ script ${gap} — not attributable to a recorded file`);
        }
    };

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
            renderActivityChildren(activity, `${childPrefix}${lastActivity ? "   " : "│  "}`);
        }
    };
    const renderActivityRoot = (activity: LineageActivity): void => {
        lines.push(activityFacts(activity));
        renderActivityChildren(activity, "");
    };
    for (const [i, root] of roots.entries()) {
        if (i > 0) lines.push("");
        if (root.kind === "activity") renderActivityRoot(root.activity);
        else renderFile(root.file, "", true, true);
    }
    // One trailing note when the rendered walk surfaced any attribution gap — counting only rendered
    // activities keeps it about what the reader is looking at, never gaps elsewhere in the document. A
    // zero-gap walk (the common case, and every document predating the attribute) appends nothing, so
    // its output stays byte-identical to before.
    if (gapActivities.size > 0) {
        lines.push("");
        lines.push(`${gapActivities.size} attribution gap${gapActivities.size === 1 ? "" : "s"}: script paths that resolved to no recorded file`);
    }
    return lines.join("\n");
}

/** A node of the flat JSON graph — kind-discriminated, carrying only the facts that kind has. */
export type LineageJsonNode =
    | { kind: "file"; path: string | null; hash: string | null; source: string | null; truncated?: true }
    | { kind: "command"; command?: string; exitCode?: number; unresolvedScript?: string; runId?: string; stepId?: string }
    | { kind: "file_tool"; tool?: string; runId?: string; stepId?: string }
    | { kind: "step" | "activity"; runId?: string; stepId?: string };

/** The flat JSON graph: direction-independent nodes + edges in PROV semantics, plus the walk's roots. */
export type LineageJson = {
    roots: string[];
    nodes: Record<string, LineageJsonNode>;
    edges: { from: string; to: string; kind: "wasGeneratedBy" | "used" }[];
};

/** The JSON node for a file entity, carrying `truncated: true` exactly when the walk recorded no expansion of it. */
function fileJsonNode(node: LineageNode, truncated: boolean): LineageJsonNode {
    const info = toFileInfo(node);
    return { kind: "file", path: info.path, hash: info.hash, source: info.source, ...(truncated ? { truncated: true as const } : {}) };
}

/** The JSON node for an activity — its rendering facts minus the QName key and the tree-only `files`. */
function activityJsonNode(node: LineageNode): LineageJsonNode {
    const { qn: _qn, ...facts } = activityMeta(node.kind === "activity" ? node : undefined, node.qn);
    // `facts` is the kind plus only the fields that kind carries (a command never has `tool`, a
    // file tool never has `command`), because `activityMeta` projects them off the model node's own
    // attributes — so the shape already satisfies the kind-discriminated union the assertion names.
    return facts as LineageJsonNode;
}

/**
 * Flatten the walk into `{ roots, nodes, edges }`. Nodes are keyed by prefixed QName, so a
 * re-encounter dedups naturally; a file node carries `truncated: true` only when the walk recorded
 * NO expansion of it anywhere — the multi-root BFS's min-distance semantics give this directly.
 * Edges are emitted in PROV semantics regardless of walk direction: `wasGeneratedBy` is always
 * entity → activity and `used` always activity → entity, so a consumer re-derives either direction
 * from one representation.
 */
export function formatJson(walk: LineageWalk): LineageJson {
    const truncated = new Set(walk.truncated);
    const nodes: Record<string, LineageJsonNode> = {};
    for (const node of walk.nodes) {
        nodes[node.qn] = isEntity(node) ? fileJsonNode(node, truncated.has(node.qn)) : activityJsonNode(node);
    }

    const edgeKeys = new Set<string>();
    const edges: LineageJson["edges"] = [];
    for (const edge of walk.edges) {
        const kind = edge.kind === "generated" ? "wasGeneratedBy" : edge.kind === "used" ? "used" : undefined;
        if (kind === undefined) continue;
        const key = `${kind}|${edge.from}|${edge.to}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ from: edge.from, to: edge.to, kind });
    }

    return { roots: [...walk.roots], nodes, edges };
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
    const gap = node.kind === "command" && node.unresolvedScript !== undefined ? `  [unresolved script ${node.unresolvedScript}]` : "";
    return `    ${dotQuoted(qn)} [shape=ellipse, label=${dotQuoted(`${activityFacts({ qn, ...node })}${gap}`)}];`;
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
export function formatDot(walk: LineageWalk): string {
    const flat = formatJson(walk);
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
export function formatMermaid(walk: LineageWalk): string {
    const flat = formatJson(walk);
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
            const gap = node.kind === "command" && node.unresolvedScript !== undefined ? `  [unresolved script ${node.unresolvedScript}]` : "";
            lines.push(`    ${idOf(qn)}[${mermaidLabel(`${activityFacts({ qn, ...node })}${gap}`)}]`);
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
 * `export` serializes — `deriveLineageModel` interprets them under the same unify the flush and
 * export use; an analysis with no recorded provenance fails with an actionable message rather than
 * an empty walk.
 */
export function runProvLineage(analysisRef: string, ref: string, rawOpts: { forward?: boolean; depth?: string; format?: string }): void {
    const opts = parseOptions(rawOpts);

    const analysis = requireAnalysisForProv(analysisRef);

    const stored = getAnalysisProvenance(analysis.id).match((s) => s, dieOn("Failed to read provenance"));
    if (stored === null) fail(`No provenance recorded for "${analysis.name}" yet — run an analysis first.`);

    const model = deriveLineageModel(stored).match((m) => m, dieOn("Stored provenance is corrupt"));

    const roots = resolveLineageRef(model, ref).match(
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

    const walk = computeLineage(model, roots, { forward: opts.forward, depth: opts.depth });
    if (opts.format === "json") console.log(JSON.stringify(formatJson(walk), null, 2));
    else if (opts.format === "dot") console.log(formatDot(walk));
    else if (opts.format === "mermaid") console.log(formatMermaid(walk));
    else console.log(formatTree(walk, { forward: opts.forward, depth: opts.depth }));
}
