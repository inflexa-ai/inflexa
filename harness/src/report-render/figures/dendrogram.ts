/**
 * The dendrogram of one category axis of a heatmap: the check of its edge table, the leaf order that the axis
 * takes, and the elbow of each edge.
 *
 * The tree table holds one row for each edge: the parent node, the child node, and the height of the parent.
 * A leaf is a child that is never a parent, and the root is the one parent that is never a child. The leaf
 * order is the depth-first order from the root, with the children of a node in the order of the table. Thus
 * the scipy `leaves_list` order and the R `hclust` order both survive, because each writes the left child
 * first.
 *
 * A leaf sits at height zero and at its place in the leaf order. An inner node sits at its height, midway
 * between the places of its outer children, as the scipy and the R dendrograms place it.
 */

import { err, ok, type Result } from "neverthrow";

import type { Cell } from "../chart.js";
import type { RenderProblem } from "../types.js";
import { chartProblem, toNumber } from "./common.js";
import type { FigureTree } from "./index.js";

/** One checked tree: the axis categories in leaf order, and the elbow of each edge in table order. */
export interface CheckedTree {
    readonly order: readonly Cell[];
    readonly height: number;
    readonly elbows: readonly Elbow[];
}

/**
 * The elbow of one edge, in tree coordinates: the place along the axis and the height of each of its three
 * points. It rises from the child to the height of the parent, then it runs across to the place of the parent.
 */
export type Elbow = readonly [readonly [number, number], readonly [number, number], readonly [number, number]];

/** One edge of the table, with its node names as text. */
interface Edge {
    readonly parent: string;
    readonly child: string;
    readonly height: number;
}

/**
 * Check the tree of one axis against the categories of that axis, and give the leaf order and the elbows.
 *
 * Each fault refuses, and the problem names the fault: an edge with an empty node, a height that is no
 * number, a node with two heights or two parents, no root or two roots, a cycle, a child over its parent, a
 * leaf that is no category, and a category that no leaf names.
 */
export function checkTree(blockId: string, axis: "x" | "y", tree: FigureTree, categories: readonly Cell[]): Result<CheckedTree, RenderProblem> {
    const fault = (detail: string): Result<never, RenderProblem> => err(chartProblem(blockId, `The tree of ${axis} ${detail}`));
    if (tree.rows.length === 0) return fault("holds no edge.");

    const edges: Edge[] = [];
    const heightOf = new Map<string, number>();
    const parentOf = new Map<string, string>();
    const childrenOf = new Map<string, string[]>();
    for (const [index, row] of tree.rows.entries()) {
        const parent = nodeName(row[tree.parent]);
        const child = nodeName(row[tree.child]);
        if (parent === undefined || child === undefined) {
            return fault(`holds an edge with no ${parent === undefined ? "parent" : "child"} at row ${index + 1}.`);
        }
        const height = toNumber(row[tree.height]);
        if (height === null) {
            return fault(`gives the node "${parent}" the height "${String(row[tree.height] ?? "")}", which is not a number.`);
        }
        const known = heightOf.get(parent);
        if (known !== undefined && known !== height) return fault(`gives the node "${parent}" two heights, ${known} and ${height}.`);
        heightOf.set(parent, height);
        const prior = parentOf.get(child);
        if (prior === parent) return fault(`holds the edge from "${parent}" to "${child}" two times.`);
        if (prior !== undefined) return fault(`gives the node "${child}" two parents, "${prior}" and "${parent}".`);
        parentOf.set(child, parent);
        const children = childrenOf.get(parent) ?? [];
        children.push(child);
        childrenOf.set(parent, children);
        edges.push({ parent, child, height });
    }

    const roots = [...childrenOf.keys()].filter((node) => !parentOf.has(node));
    if (roots.length === 0) return fault(`holds a cycle through the node "${edges[0].parent}".`);
    if (roots.length > 1) return fault(`holds more than one root, for example "${roots[0]}" and "${roots[1]}". A tree holds one root.`);

    // Each child has one parent and the root has none, thus a walk from the root meets each node one time. A
    // node that the walk never meets sits on a cycle apart from the root.
    const preorder: string[] = [];
    const stack = [roots[0]];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        preorder.push(node);
        const children = childrenOf.get(node) ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    const met = new Set(preorder);
    const stray = edges.find((edge) => !met.has(edge.parent));
    if (stray !== undefined) return fault(`holds a cycle through the node "${stray.parent}".`);

    for (const edge of edges) {
        const own = heightOf.get(edge.child);
        if (own !== undefined && own > edge.height) {
            return fault(`puts the node "${edge.child}" at the height ${own}, over the height ${edge.height} of its parent "${edge.parent}".`);
        }
    }

    const byName = new Map<string, Cell>();
    for (const category of categories) byName.set(String(category), category);
    const leaves = preorder.filter((node) => !childrenOf.has(node));
    const order: Cell[] = [];
    for (const leaf of leaves) {
        const category = byName.get(leaf);
        if (category === undefined) return fault(`holds the leaf "${leaf}", which is no category of the ${axis} axis.`);
        order.push(category);
    }
    const named = new Set(leaves);
    const absent = categories.find((category) => !named.has(String(category)));
    if (absent !== undefined) return fault(`holds no leaf for the ${axis} category "${String(absent)}".`);

    const place = new Map<string, number>(leaves.map((leaf, index) => [leaf, index]));
    // The reverse of the preorder meets each child before its parent, and the walk met each node, thus each
    // lookup below finds a place.
    const placeOf = (node: string): number => place.get(node) as number;
    for (let index = preorder.length - 1; index >= 0; index -= 1) {
        const node = preorder[index];
        const children = childrenOf.get(node);
        if (children === undefined) continue;
        let low = Infinity;
        let high = -Infinity;
        for (const child of children) {
            low = Math.min(low, placeOf(child));
            high = Math.max(high, placeOf(child));
        }
        place.set(node, (low + high) / 2);
    }
    const heightAt = (node: string): number => heightOf.get(node) ?? 0;
    const elbows = edges.map((edge): Elbow => {
        const child = placeOf(edge.child);
        return [
            [child, heightAt(edge.child)],
            [child, edge.height],
            [placeOf(edge.parent), edge.height],
        ];
    });
    return ok({ order, height: heightAt(roots[0]), elbows });
}

/** The name of one node cell, or `undefined` for an empty cell. */
function nodeName(cell: Cell | undefined): string | undefined {
    if (cell === undefined) return undefined;
    const name = String(cell);
    return name === "" ? undefined : name;
}
