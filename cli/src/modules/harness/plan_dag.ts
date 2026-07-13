import { Result } from "neverthrow";

import { GLYPHS } from "../../lib/design_system.ts";

export type PlanDagStep = {
    readonly id: string;
    readonly name: string;
    readonly depends_on: readonly string[];
};

export type PlanDagOptions = {
    /** Maximum visible step-name length before a single-cell ellipsis is appended. */
    readonly maxNameLength?: number;
};

export type PlanDagError = { type: "render_failed"; cause: unknown };

const U = 1;
const D = 2;
const L = 4;
const R = 8;
const BOX_HEIGHT = 3;
const LEVEL_GAP = 3;
const BOX_GAP = 4;
const DEFAULT_MAX_NAME_LENGTH = 24;

type Point = { x: number; y: number };

const glyphByDirections: Readonly<Record<number, string>> = {
    [U]: GLYPHS.lineVertical,
    [D]: GLYPHS.lineVertical,
    [L]: GLYPHS.lineHorizontal,
    [R]: GLYPHS.lineHorizontal,
    [U | D]: GLYPHS.lineVertical,
    [L | R]: GLYPHS.lineHorizontal,
    [D | R]: GLYPHS.cornerDownRight,
    [D | L]: GLYPHS.cornerDownLeft,
    [U | R]: GLYPHS.cornerUpRight,
    [U | L]: GLYPHS.cornerUpLeft,
    [D | L | R]: GLYPHS.teeDown,
    [U | L | R]: GLYPHS.teeUp,
    [U | D | R]: GLYPHS.teeRight,
    [U | D | L]: GLYPHS.teeLeft,
    [U | D | L | R]: GLYPHS.lineCross,
};

/**
 * Render dependency structure as a top-to-bottom ASCII DAG. The function owns no harness types:
 * callers pass the copied primitive plan-card view. Failures stay in `Result`, so presentation
 * callers can degrade to their flat-list rendering without catching exceptions.
 */
export function planToDag(steps: readonly PlanDagStep[], options: PlanDagOptions = {}): Result<string, PlanDagError> {
    return Result.fromThrowable(
        () => renderPlan(steps, options),
        (cause): PlanDagError => ({ type: "render_failed", cause }),
    )();
}

function renderPlan(steps: readonly PlanDagStep[], options: PlanDagOptions): string {
    if (steps.length === 0) return "";

    const maxNameLength = Math.max(1, Math.floor(options.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH));
    const byId = new Map(steps.map((step) => [step.id, step]));
    const levels = computeLevels(steps, byId);
    const grouped = new Map<number, PlanDagStep[]>();
    for (const step of steps) {
        const level = levels.get(step.id) ?? 0;
        const group = grouped.get(level) ?? [];
        group.push(step);
        grouped.set(level, group);
    }

    const maxLevel = Math.max(...grouped.keys());
    const rows = Array.from({ length: maxLevel + 1 }, (_, level) => grouped.get(level) ?? []);
    const maxPerLevel = Math.max(...rows.map((row) => row.length));
    const idWidth = Math.max(...steps.map((step) => step.id.length));
    const contentWidth = idWidth + 1 + maxNameLength;
    const boxWidth = contentWidth + 4;
    const baseWidth = maxPerLevel * boxWidth + Math.max(0, maxPerLevel - 1) * BOX_GAP;

    const longEdges = steps.flatMap((step) =>
        step.depends_on
            .filter((parentId) => byId.has(parentId) && (levels.get(step.id) ?? 0) - (levels.get(parentId) ?? 0) > 1)
            .map((parentId) => ({ parentId, childId: step.id })),
    );
    const longLaneByEdge = new Map(longEdges.map((edge, index) => [`${edge.parentId}\0${edge.childId}`, baseWidth + 2 + index * 2]));
    const width = baseWidth + (longEdges.length > 0 ? 2 + longEdges.length * 2 : 0);
    const height = rows.length * BOX_HEIGHT + Math.max(0, rows.length - 1) * LEVEL_GAP;
    const bits = Array.from({ length: height }, () => Array<number>(width).fill(0));
    const text = Array.from({ length: height }, () => Array<string | null>(width).fill(null));
    const positions = new Map<string, Point>();

    for (let level = 0; level < rows.length; level++) {
        const row = rows[level] ?? [];
        const rowWidth = row.length * boxWidth + Math.max(0, row.length - 1) * BOX_GAP;
        const offset = Math.floor((baseWidth - rowWidth) / 2);
        const y = level * (BOX_HEIGHT + LEVEL_GAP);
        for (let index = 0; index < row.length; index++) {
            const step = row[index];
            if (!step) continue;
            const x = offset + index * (boxWidth + BOX_GAP);
            positions.set(step.id, { x, y });
            drawBox(bits, text, x, y, boxWidth, stepLabel(step, idWidth, maxNameLength).padEnd(contentWidth));
        }
    }

    for (const child of steps) {
        const childPosition = positions.get(child.id);
        if (!childPosition) continue;
        for (const parentId of child.depends_on) {
            const parentPosition = positions.get(parentId);
            if (!parentPosition) continue;
            const parentLevel = levels.get(parentId) ?? 0;
            const childLevel = levels.get(child.id) ?? 0;
            if (childLevel <= parentLevel) continue;

            const source = { x: parentPosition.x + Math.floor(boxWidth / 2), y: parentPosition.y + BOX_HEIGHT - 1 };
            const target = { x: childPosition.x + Math.floor(boxWidth / 2), y: childPosition.y };
            if (childLevel === parentLevel + 1) {
                const laneY = source.y + 2;
                drawPath(bits, [source, { x: source.x, y: laneY }, { x: target.x, y: laneY }, target]);
            } else {
                const laneX = longLaneByEdge.get(`${parentId}\0${child.id}`) ?? baseWidth;
                drawPath(bits, [
                    source,
                    { x: source.x, y: source.y + 1 },
                    { x: laneX, y: source.y + 1 },
                    { x: laneX, y: target.y - 1 },
                    { x: target.x, y: target.y - 1 },
                    target,
                ]);
            }
        }
    }

    return bits
        .map((row, y) =>
            row
                .map((directions, x) => text[y]?.[x] ?? glyphByDirections[directions] ?? " ")
                .join("")
                .trimEnd(),
        )
        .join("\n")
        .trimEnd();
}

/** Kahn traversal yields longest-path levels; nodes left by a cycle fall back to level zero. */
function computeLevels(steps: readonly PlanDagStep[], byId: ReadonlyMap<string, PlanDagStep>): Map<string, number> {
    const indegree = new Map(steps.map((step) => [step.id, 0]));
    const children = new Map<string, string[]>();
    for (const step of steps) {
        for (const parentId of step.depends_on) {
            if (!byId.has(parentId)) continue;
            indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
            const next = children.get(parentId) ?? [];
            next.push(step.id);
            children.set(parentId, next);
        }
    }

    const levels = new Map(steps.map((step) => [step.id, 0]));
    const queue = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
    for (let index = 0; index < queue.length; index++) {
        const parentId = queue[index];
        if (parentId === undefined) continue;
        for (const childId of children.get(parentId) ?? []) {
            levels.set(childId, Math.max(levels.get(childId) ?? 0, (levels.get(parentId) ?? 0) + 1));
            const remaining = (indegree.get(childId) ?? 1) - 1;
            indegree.set(childId, remaining);
            if (remaining === 0) queue.push(childId);
        }
    }
    for (const [id, remaining] of indegree) if (remaining > 0) levels.set(id, 0);
    return levels;
}

function stepLabel(step: PlanDagStep, idWidth: number, maxNameLength: number): string {
    const name = step.name.length > maxNameLength ? `${step.name.slice(0, maxNameLength - 1)}${GLYPHS.ellipsis}` : step.name;
    return `${step.id.padEnd(idWidth)} ${name}`;
}

function drawBox(bits: number[][], text: (string | null)[][], x: number, y: number, width: number, label: string): void {
    drawPath(bits, [
        { x, y },
        { x: x + width - 1, y },
        { x: x + width - 1, y: y + BOX_HEIGHT - 1 },
        { x, y: y + BOX_HEIGHT - 1 },
        { x, y },
    ]);
    const labelRow = text[y + 1];
    if (!labelRow) return;
    const chars = [...` ${label} `];
    for (let index = 0; index < chars.length; index++) {
        const char = chars[index];
        if (char === undefined) continue;
        labelRow[x + 1 + index] = char;
    }
}

function drawPath(bits: number[][], points: readonly Point[]): void {
    for (let index = 1; index < points.length; index++) {
        const from = points[index - 1];
        const to = points[index];
        if (!from || !to) continue;
        const dx = Math.sign(to.x - from.x);
        const dy = Math.sign(to.y - from.y);
        let cursor = from;
        while (cursor.x !== to.x || cursor.y !== to.y) {
            const next = { x: cursor.x + dx, y: cursor.y + dy };
            connect(bits, cursor, next);
            cursor = next;
        }
    }
}

function connect(bits: number[][], from: Point, to: Point): void {
    const fromRow = bits[from.y];
    const toRow = bits[to.y];
    const fromValue = fromRow?.[from.x];
    const toValue = toRow?.[to.x];
    if (!fromRow || !toRow || fromValue === undefined || toValue === undefined) return;
    if (to.x > from.x) {
        fromRow[from.x] = fromValue | R;
        toRow[to.x] = toValue | L;
    } else if (to.x < from.x) {
        fromRow[from.x] = fromValue | L;
        toRow[to.x] = toValue | R;
    } else if (to.y > from.y) {
        fromRow[from.x] = fromValue | D;
        toRow[to.x] = toValue | U;
    } else if (to.y < from.y) {
        fromRow[from.x] = fromValue | U;
        toRow[to.x] = toValue | D;
    }
}
