import { err, ok, type Result } from "neverthrow";
import {
    Literal,
    PROV_LABEL,
    ProvActivity,
    ProvAgent,
    ProvAssociation,
    ProvAttribution,
    ProvCommunication,
    ProvDerivation,
    ProvDocument,
    ProvEntity,
    ProvGeneration,
    ProvInvalidation,
    ProvUsage,
    type ProvRecord,
} from "@inflexa-ai/tsprov";
import { PROV_UNIFY_OPTIONS } from "./document.js";
import type { ProvFileKey } from "./types.js";

// The read side of the dialect: one interpretation of a stored PROV-JSON document, shared by every
// consumer. `deriveLineageModel` turns the exact stored bytes into a typed, presentation-free
// node/edge model. `computeLineage` walks the generation/usage edges with the canonical traversal
// semantics. `findFileEntity` is the `(path, hash)` identity lookup that cross-links an external
// artifact record to its entity. A consumer that interprets the bytes itself can drift, and two
// drifted readers show two different lineages for one signed document — thus the interpretation is
// format and lives in the kernel.

/** Why a document did not derive: the bytes do not parse or unify as a dialect document. */
export type ProvReadError = { type: "prov_corrupt"; cause: unknown };

/** The dialect entity node kinds — the three declared entity types, with a QName-prefix fallback. */
export type LineageAnalysisNode = { kind: "analysis"; qn: string; label: string; name?: string; slug?: string };
export type LineageInputNode = { kind: "input"; qn: string; label: string; path?: string; isDir?: boolean };
export type LineageFileNode = {
    kind: "file";
    qn: string;
    label: string;
    path?: string;
    hash?: string;
    size?: number;
    /** How the bytes came to exist (`command` or `file_tool`) — present on a written file. */
    producer?: string;
    /** The read classification (`data`/`upstream`/`prior`/`step`) — present on a read input. */
    source?: string;
    fileId?: string;
};

export type LineageActivityKind = "run" | "step" | "command" | "file_tool" | "action";

export type LineageActivityNode = {
    kind: "activity";
    qn: string;
    activity: LineageActivityKind;
    label: string;
    /** The `inflexa:*` action type localpart, for the `action` kind. */
    actionType?: string;
    startTime?: string;
    endTime?: string;
    status?: string;
    durationMs?: number;
    runId?: string;
    stepId?: string;
    command?: string;
    args?: string;
    exitCode?: number;
    tool?: string;
    unresolvedScript?: string;
    planSummary?: string;
};

export type LineageAgentKind = "system" | "user" | "model";

export type LineageAgentNode = {
    kind: "agent";
    qn: string;
    agent: LineageAgentKind;
    label: string;
    email?: string;
    version?: string;
    commit?: string;
    model?: string;
};

export type LineageNode = LineageAnalysisNode | LineageInputNode | LineageFileNode | LineageActivityNode | LineageAgentNode;

export type LineageEdgeKind = "used" | "generated" | "informed" | "derived" | "attributed" | "associated" | "invalidated";

/**
 * One relation as an edge, in the PROV assertion orientation (formal argument 0 to formal argument
 * 1): a `generated` edge points entity to activity, a `used` edge activity to entity. The id is the
 * relation's deterministic dialect id; an anonymous lifecycle relation gets the value-derived
 * fallback `{kind}:{from}->{to}`.
 */
export type LineageEdge = { id: string; kind: LineageEdgeKind; from: string; to: string };

export type LineageModel = { nodes: LineageNode[]; edges: LineageEdge[] };

/** The first value of an `inflexa:*` attribute, unwrapped from its literal. */
function attr(record: ProvRecord, name: string): unknown {
    const values = record.getAttribute(`inflexa:${name}`);
    if (values.length === 0) return undefined;
    const v = values[0];
    return v instanceof Literal ? v.value : v;
}

function attrString(record: ProvRecord, name: string): string | undefined {
    const v = attr(record, name);
    return typeof v === "string" ? v : undefined;
}

function attrNumber(record: ProvRecord, name: string): number | undefined {
    const v = attr(record, name);
    return typeof v === "number" ? v : undefined;
}

function attrBoolean(record: ProvRecord, name: string): boolean | undefined {
    const v = attr(record, name);
    return typeof v === "boolean" ? v : undefined;
}

/** The asserted `inflexa:*` type localparts of a record, for example `File` or `Run`. */
function dialectTypes(record: ProvRecord): string[] {
    return record
        .getAssertedTypes()
        .map((t) => String(t))
        .filter((t) => t.startsWith("inflexa:"))
        .map((t) => t.slice("inflexa:".length));
}

function provLabel(record: ProvRecord): string | undefined {
    const values = record.getAttribute(PROV_LABEL);
    return values.length > 0 ? String(values[0]) : undefined;
}

/** The QName's localpart, for example `file-18bvqsvo19q9p` from `inflexa:file-…`. */
function localpart(qn: string): string {
    const colon = qn.indexOf(":");
    return colon === -1 ? qn : qn.slice(colon + 1);
}

function entityKindOf(types: string[], qn: string): "analysis" | "input" | "file" {
    if (types.includes("Analysis")) return "analysis";
    if (types.includes("Input")) return "input";
    if (types.includes("File")) return "file";
    // A read input carries no prov:type (SPEC.md) — fall back to the QName prefix.
    const local = localpart(qn);
    if (local.startsWith("analysis-")) return "analysis";
    if (local.startsWith("input-")) return "input";
    return "file";
}

function toEntityNode(record: ProvEntity): LineageNode {
    const qn = String(record.identifier);
    const kind = entityKindOf(dialectTypes(record), qn);
    const path = attrString(record, "path");
    if (kind === "analysis") {
        const name = attrString(record, "name");
        const slug = attrString(record, "slug");
        return { kind, qn, label: name ?? localpart(qn), ...(name !== undefined ? { name } : {}), ...(slug !== undefined ? { slug } : {}) };
    }
    if (kind === "input") {
        const isDir = attrBoolean(record, "isDir");
        return { kind, qn, label: path ?? localpart(qn), ...(path !== undefined ? { path } : {}), ...(isDir !== undefined ? { isDir } : {}) };
    }
    const hash = attrString(record, "hash");
    const size = attrNumber(record, "size");
    const producer = attrString(record, "producer");
    const source = attrString(record, "source");
    const fileId = attrString(record, "fileId");
    return {
        kind,
        qn,
        label: path ?? localpart(qn),
        ...(path !== undefined ? { path } : {}),
        ...(hash !== undefined ? { hash } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(producer !== undefined ? { producer } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(fileId !== undefined ? { fileId } : {}),
    };
}

function activityKindOf(types: string[], qn: string): { activity: LineageActivityKind; actionType?: string } {
    if (types.includes("Run")) return { activity: "run" };
    if (types.includes("Step")) return { activity: "step" };
    if (types.includes("Command")) return { activity: "command" };
    if (types.includes("FileToolWrite")) return { activity: "file_tool" };
    const local = localpart(qn);
    if (local.startsWith("action-")) return { activity: "action", ...(types[0] !== undefined ? { actionType: types[0] } : {}) };
    if (local.startsWith("run-")) return { activity: "run" };
    if (local.startsWith("step-")) return { activity: "step" };
    if (local.startsWith("cmd-")) return { activity: "command" };
    // A lifecycle action is the only remaining dialect activity kind.
    return { activity: "action", ...(types[0] !== undefined ? { actionType: types[0] } : {}) };
}

/** A formal time as its ISO string; dialect times are always UTC. */
function timeString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return String(value);
}

function toActivityNode(record: ProvActivity): LineageActivityNode {
    const qn = String(record.identifier);
    const { activity, actionType } = activityKindOf(dialectTypes(record), qn);
    const command = attrString(record, "command");
    const tool = attrString(record, "tool");
    const runId = attrString(record, "runId");
    const stepId = attrString(record, "stepId");
    const label =
        activity === "command"
            ? (command ?? localpart(qn))
            : activity === "file_tool"
              ? (tool ?? localpart(qn))
              : activity === "run"
                ? (runId ?? localpart(qn))
                : activity === "step"
                  ? (stepId ?? localpart(qn))
                  : (actionType ?? localpart(qn));
    const startTime = timeString(record.getStartTime());
    const endTime = timeString(record.getEndTime());
    const status = attrString(record, "status");
    const durationMs = attrNumber(record, "durationMs");
    const args = attrString(record, "args");
    const exitCode = attrNumber(record, "exitCode");
    const unresolvedScript = attrString(record, "unresolvedScript");
    const planSummary = attrString(record, "planSummary");
    return {
        kind: "activity",
        qn,
        activity,
        label,
        ...(actionType !== undefined ? { actionType } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(stepId !== undefined ? { stepId } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(tool !== undefined ? { tool } : {}),
        ...(unresolvedScript !== undefined ? { unresolvedScript } : {}),
        ...(planSummary !== undefined ? { planSummary } : {}),
    };
}

function agentKindOf(record: ProvAgent): LineageAgentKind {
    const types = record.getAssertedTypes().map((t) => String(t));
    if (types.includes("inflexa:Model")) return "model";
    if (types.includes("prov:Person")) return "user";
    return "system";
}

function toAgentNode(record: ProvAgent): LineageAgentNode {
    const qn = String(record.identifier);
    const email = attrString(record, "email");
    const version = attrString(record, "version");
    const commit = attrString(record, "commit");
    const model = attrString(record, "model");
    return {
        kind: "agent",
        qn,
        agent: agentKindOf(record),
        label: provLabel(record) ?? email ?? localpart(qn),
        ...(email !== undefined ? { email } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(commit !== undefined ? { commit } : {}),
        ...(model !== undefined ? { model } : {}),
    };
}

type EndpointRole = "entity" | "activity" | "agent";

type EdgeSpec = { kind: LineageEdgeKind; fromRole: EndpointRole; toRole: EndpointRole };

/**
 * The seven relation kinds the model carries, each in the PROV formal argument order (argument 0 is
 * `from`, argument 1 is `to`). Any other statement kind — delegation, or a kind a future dialect
 * adds — returns null and is skipped.
 */
function edgeSpecOf(record: ProvRecord): EdgeSpec | null {
    if (record instanceof ProvUsage) return { kind: "used", fromRole: "activity", toRole: "entity" };
    if (record instanceof ProvGeneration) return { kind: "generated", fromRole: "entity", toRole: "activity" };
    if (record instanceof ProvCommunication) return { kind: "informed", fromRole: "activity", toRole: "activity" };
    if (record instanceof ProvDerivation) return { kind: "derived", fromRole: "entity", toRole: "entity" };
    if (record instanceof ProvAttribution) return { kind: "attributed", fromRole: "entity", toRole: "agent" };
    if (record instanceof ProvAssociation) return { kind: "associated", fromRole: "activity", toRole: "agent" };
    if (record instanceof ProvInvalidation) return { kind: "invalidated", fromRole: "entity", toRole: "activity" };
    return null;
}

/** A minimal node for a relation endpoint the document references but never declares. */
function synthesizeNode(role: EndpointRole, qn: string): LineageNode {
    if (role === "entity") return { kind: entityKindOf([], qn), qn, label: localpart(qn) };
    if (role === "activity") return { kind: "activity", qn, activity: activityKindOf([], qn).activity, label: localpart(qn) };
    return { kind: "agent", qn, agent: "system", label: localpart(qn) };
}

function modelOf(doc: ProvDocument): LineageModel {
    const nodes = new Map<string, LineageNode>();
    const records = doc.getRecords();
    for (const record of records) {
        if (record instanceof ProvEntity) nodes.set(String(record.identifier), toEntityNode(record));
        else if (record instanceof ProvAgent) nodes.set(String(record.identifier), toAgentNode(record));
        else if (record instanceof ProvActivity) nodes.set(String(record.identifier), toActivityNode(record));
    }

    const edges = new Map<string, LineageEdge>();
    const endpointRoles = new Map<string, EndpointRole>();
    for (const record of records) {
        const spec = edgeSpecOf(record);
        if (spec === null) continue;
        const from = record.args[0];
        const to = record.args[1];
        if (from === undefined || to === undefined) continue;
        const fromQn = String(from);
        const toQn = String(to);
        const id = record.identifier ? String(record.identifier) : `${spec.kind}:${fromQn}->${toQn}`;
        edges.set(id, { id, kind: spec.kind, from: fromQn, to: toQn });
        endpointRoles.set(fromQn, spec.fromRole);
        endpointRoles.set(toQn, spec.toRole);
    }

    // A relation can reference an element the document never declares (for example a resolved
    // script's file entity) — synthesize a minimal node so no edge dangles.
    for (const [qn, role] of endpointRoles) {
        if (!nodes.has(qn)) nodes.set(qn, synthesizeNode(role, qn));
    }

    // A command carries no runId/stepId attributes of its own — inherit them from the activity
    // that informed it (its step), read off the `informed` edge.
    for (const edge of edges.values()) {
        if (edge.kind !== "informed") continue;
        const informed = nodes.get(edge.from);
        const informant = nodes.get(edge.to);
        if (informed?.kind !== "activity" || informant?.kind !== "activity") continue;
        if (informed.runId !== undefined || informed.stepId !== undefined) continue;
        if (informant.runId !== undefined) informed.runId = informant.runId;
        if (informant.stepId !== undefined) informed.stepId = informant.stepId;
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Derive the lineage model from the exact stored PROV-JSON bytes — the same bytes the signature
 * covers. The document unifies under {@link PROV_UNIFY_OPTIONS} first, thus the model reads the
 * last-write-wins survivor of each record. Bytes that do not parse or unify return `prov_corrupt`.
 */
export function deriveLineageModel(provJson: string): Result<LineageModel, ProvReadError> {
    try {
        return ok(modelOf(ProvDocument.deserialize(provJson, "json").unified(PROV_UNIFY_OPTIONS)));
    } catch (cause) {
        return err({ type: "prov_corrupt", cause });
    }
}

/**
 * Walk the lineage of `roots` and return the reached sub-model. The walk traverses ONLY the
 * `generated` and `used` edges: the coarse `derived` edge to the analysis and the `informed` spine
 * would pollute a file's lineage, so they stay out. Backward follows the asserted edges (a file to
 * its generator, an activity to what it read); forward reverses them (a file to its readers, an
 * activity to its outputs).
 *
 * `depth` counts file-level hops. One file hop (file to activity to file) is two edges, thus the
 * edge budget is `2n` from a file root and `2n - 1` from an activity root — a truncation always
 * lands on a file node, never between an activity and its files. An unset `depth` walks the whole
 * reachable component. A root the model does not contain adds nothing.
 */
export function computeLineage(model: LineageModel, roots: readonly string[], opts: { direction: "forward" | "backward"; depth?: number }): LineageModel {
    const nodeByQn = new Map(model.nodes.map((n) => [n.qn, n]));
    const adjacency = new Map<string, { edge: LineageEdge; to: string }[]>();
    for (const edge of model.edges) {
        if (edge.kind !== "generated" && edge.kind !== "used") continue;
        const [from, to] = opts.direction === "backward" ? [edge.from, edge.to] : [edge.to, edge.from];
        const bucket = adjacency.get(from);
        if (bucket) bucket.push({ edge, to });
        else adjacency.set(from, [{ edge, to }]);
    }

    // Breadth-first over the directed adjacency, keyed by the best remaining edge budget per node —
    // a node reached again with a larger budget re-expands, so the bound is the minimum distance
    // over all roots.
    const best = new Map<string, number>();
    const queue: { qn: string; remaining: number }[] = [];
    for (const qn of roots) {
        const root = nodeByQn.get(qn);
        if (root === undefined) continue;
        const remaining = opts.depth === undefined ? Number.POSITIVE_INFINITY : root.kind === "activity" ? 2 * opts.depth - 1 : 2 * opts.depth;
        if ((best.get(qn) ?? -1) < remaining) {
            best.set(qn, remaining);
            queue.push({ qn, remaining });
        }
    }
    const reached = new Map<string, LineageEdge>();
    for (let i = 0; i < queue.length; i++) {
        const { qn, remaining } = queue[i]!;
        if (remaining !== best.get(qn) || remaining <= 0) continue;
        for (const { edge, to } of adjacency.get(qn) ?? []) {
            reached.set(edge.id, edge);
            const next = remaining - 1;
            if ((best.get(to) ?? -1) < next) {
                best.set(to, next);
                queue.push({ qn: to, remaining: next });
            }
        }
    }

    return { nodes: model.nodes.filter((n) => best.has(n.qn)), edges: model.edges.filter((e) => reached.has(e.id)) };
}

/**
 * Find the file entity for a `(path, content hash)` key — the identity that cross-links an external
 * artifact record to its entity in the model (entity QNames are document-internal).
 */
export function findFileEntity(model: LineageModel, key: ProvFileKey): LineageFileNode | undefined {
    return model.nodes.find((n): n is LineageFileNode => n.kind === "file" && n.path === key.path && n.hash === key.hash);
}
